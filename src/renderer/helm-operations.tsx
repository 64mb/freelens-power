import { Renderer } from "@freelensapp/extensions";
import { clipboard, ipcRenderer } from "electron";
import { makeAutoObservable, runInAction } from "mobx";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { HELM_CHANNEL, type HelmOperation, type HelmRequest, type HelmResponse } from "../common/helm";

const { Dialog: NativeDialog, Button, Icon, Checkbox } = Renderer.Component;
const MAX_RECORDS = 30;
const MAX_LOGS = 500;
const failure = {
  code: "TRANSPORT_ERROR",
  message: "Connection interrupted. Waiting to reconnect and confirm the rollback status.",
};
const terminal = (operation: HelmOperation) => operation.status !== "running";
const matches = (operation: HelmOperation, clusterId: string, contextId?: string) =>
  operation.clusterId === clusterId && operation.contextId === (contextId ?? "");

export class HelmOperationsStore {
  operations: HelmOperation[] = [];
  selectedId: string | undefined;
  dismissed: string[] = [];
  uncertain = new Map<string, number>();
  localTerminal = new Set<string>();

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  merge(incoming: HelmOperation[], authoritative = true) {
    for (const snapshot of incoming) {
      const index = this.operations.findIndex((item) => item.requestId === snapshot.requestId);
      const current = this.operations[index];
      const replaceLocal = authoritative && this.localTerminal.has(snapshot.requestId);
      if (!replaceLocal && current && terminal(current) && !terminal(snapshot)) continue;
      if (!replaceLocal && current?.finishedAt && snapshot.finishedAt && current.finishedAt > snapshot.finishedAt)
        continue;
      const phases = ["preparing", "applying", "waiting", "completed", "failed"];
      if (
        !replaceLocal &&
        current &&
        !terminal(snapshot) &&
        phases.indexOf(current.phase) > phases.indexOf(snapshot.phase)
      )
        continue;
      if (authoritative) {
        this.uncertain.delete(snapshot.requestId);
        this.localTerminal.delete(snapshot.requestId);
      }
      const logs = snapshot.logs.length >= (current?.logs.length ?? 0) ? snapshot.logs : current.logs;
      const next = { ...snapshot, logs: logs.slice(-MAX_LOGS) };
      if (index < 0) this.operations.push(next);
      else this.operations[index] = next;
    }
    const running = this.operations.filter((item) => !terminal(item));
    this.operations = [
      ...running,
      ...this.operations
        .filter(terminal)
        .sort((first, second) => (first.finishedAt ?? first.startedAt) - (second.finishedAt ?? second.startedAt))
        .slice(-MAX_RECORDS),
    ];
    this.dismissed = this.dismissed.filter((id) => this.operations.some((item) => item.requestId === id));
    for (const id of this.localTerminal)
      if (!this.operations.some((item) => item.requestId === id)) this.localTerminal.delete(id);
  }

  reconcile(snapshots: HelmOperation[], clusterId: string, contextId: string | undefined, generation: number) {
    const scoped = snapshots.filter((item) => matches(item, clusterId, contextId));
    this.merge(scoped);
    for (const [requestId, afterGeneration] of this.uncertain) {
      const current = this.operations.find((item) => item.requestId === requestId);
      if (!current || !matches(current, clusterId, contextId) || generation <= afterGeneration) continue;
      if (scoped.some((item) => item.requestId === requestId)) continue;
      this.uncertain.delete(requestId);
      this.localTerminal.add(requestId);
      this.merge(
        [
          {
            ...current,
            status: "failed",
            phase: "failed",
            finishedAt: Date.now(),
            error: {
              code: "OPERATION_NOT_FOUND",
              message: "The rollback could not be confirmed. Check release history before starting another operation.",
            },
          },
        ],
        false,
      );
    }
  }

  isRunning(clusterId: string, contextId: string | undefined, namespace: string, name: string) {
    return this.operations.some(
      (item) =>
        matches(item, clusterId, contextId) && item.namespace === namespace && item.name === name && !terminal(item),
    );
  }

  open(requestId: string) {
    this.selectedId = requestId;
  }
  minimize() {
    this.selectedId = undefined;
  }
  dismiss(requestId: string) {
    this.dismissed.push(requestId);
  }

  async start(payload: HelmRequest): Promise<HelmResponse> {
    if (this.isRunning(payload.clusterId, payload.contextId, payload.namespace, payload.name ?? "")) {
      return {
        ok: false,
        error: { code: "OPERATION_RUNNING", message: "A rollback is already running for this release." },
      };
    }
    const provisional: HelmOperation = {
      id: payload.requestId,
      requestId: payload.requestId,
      clusterId: payload.clusterId,
      contextId: payload.contextId ?? "",
      namespace: payload.namespace,
      name: payload.name ?? "",
      revision: payload.revision ?? 0,
      status: "running",
      phase: "preparing",
      startedAt: Date.now(),
      logs: [],
    };
    this.merge([provisional], false);
    this.open(payload.requestId);
    let response: HelmResponse;
    try {
      response = await ipcRenderer.invoke(HELM_CHANNEL, payload);
    } catch {
      runInAction(() => {
        const current = this.operations.find((item) => item.requestId === payload.requestId);
        if (current && !terminal(current)) {
          this.uncertain.set(payload.requestId, pollSequence);
          this.merge([{ ...current, error: failure }], false);
        }
      });
      return { ok: false, error: failure };
    }
    runInAction(() => {
      if ("operations" in response && response.operations) this.merge(response.operations);
      const current = this.operations.find((item) => item.requestId === payload.requestId);
      if (
        current &&
        !terminal(current) &&
        !("operations" in response && response.operations?.some((item) => item.requestId === payload.requestId))
      ) {
        this.localTerminal.add(payload.requestId);
        this.merge(
          [
            {
              ...current,
              status: response.ok ? "succeeded" : "failed",
              phase: response.ok ? "completed" : "failed",
              finishedAt: Date.now(),
              error: response.ok === false ? response.error : undefined,
            },
          ],
          false,
        );
      }
    });
    return response;
  }
}

export const helmOperations = new HelmOperationsStore();
let pollSequence = 0;
const pollers = new Map<string, { subscribers: number; stop: () => void }>();
function subscribe(clusterId: string, contextId?: string) {
  const key = JSON.stringify([clusterId, contextId]);
  const existing = pollers.get(key);
  if (existing) {
    existing.subscribers++;
    return () => unsubscribe(key);
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    const generation = ++pollSequence;
    try {
      const response: HelmResponse = await ipcRenderer.invoke(HELM_CHANNEL, {
        operation: "operations",
        requestId: `operations-${generation}`,
        clusterId,
        contextId,
        namespace: "",
      } satisfies HelmRequest);
      if (!stopped && response.ok && response.operations) {
        helmOperations.reconcile(response.operations, clusterId, contextId, generation);
      }
    } catch {
      /* polling resumes after transient transport failures */
    }
    if (!stopped)
      timer = setTimeout(
        poll,
        helmOperations.operations.some((item) => matches(item, clusterId, contextId) && !terminal(item)) ? 1000 : 5000,
      );
  };
  pollers.set(key, {
    subscribers: 1,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  });
  void poll();
  return () => unsubscribe(key);
}
function unsubscribe(key: string) {
  const poller = pollers.get(key);
  if (poller && --poller.subscribers === 0) {
    poller.stop();
    pollers.delete(key);
  }
}

const duration = (startedAt: number, finishedAt: number) => {
  const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const elapsed = (operation: HelmOperation, now: number) => duration(operation.startedAt, operation.finishedAt ?? now);
const stagePhases = ["preparing", "applying", "waiting"] as const;
const logTime = (at: number) => {
  const date = new Date(at);
  const padded = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}.${padded(date.getMilliseconds(), 3)}`;
};
const phaseLabels = {
  preparing: "Preparing",
  applying: "Applying release",
  waiting: "Waiting for resources",
  completed: "Completed",
  failed: "Failed",
};

const OperationDialog = observer(
  ({ operation, onViewHistory }: { operation: HelmOperation; onViewHistory: (operation: HelmOperation) => void }) => {
    const [ready, setReady] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [follow, setFollow] = useState(true);
    const [copied, setCopied] = useState(false);
    const log = useRef<HTMLPreElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const returnFocus = useRef(document.activeElement as HTMLElement | null);
    const active = !terminal(operation);
    useEffect(() => {
      const timer = setTimeout(() => setReady(true), 0);
      return () => {
        clearTimeout(timer);
        const card = Array.from(document.querySelectorAll<HTMLElement>(".power-helm-operation-card")).find(
          (node) => node.dataset.requestId === operation.requestId,
        );
        const target = returnFocus.current?.isConnected
          ? returnFocus.current
          : card?.querySelector<HTMLButtonElement>("button");
        target?.focus();
      };
    }, []);
    useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [active]);
    useEffect(() => {
      if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
    }, [follow, operation.logs]);
    useEffect(() => {
      const escape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        helmOperations.minimize();
      };
      document.addEventListener("keydown", escape, true);
      return () => document.removeEventListener("keydown", escape, true);
    }, []);
    useEffect(() => {
      if (!ready) return;
      dialog.current?.focus();
      const trap = (event: KeyboardEvent) => {
        if (event.key !== "Tab" || !dialog.current) return;
        const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("*")).filter(
          (node) =>
            node.matches("button:not(:disabled), input:not(:disabled), summary, [tabindex='0']") &&
            (!node.closest("details:not([open])") || node.tagName === "SUMMARY"),
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.current.focus();
          return;
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialog.current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
        event.stopPropagation();
      };
      document.addEventListener("keydown", trap, true);
      return () => document.removeEventListener("keydown", trap, true);
    }, [ready]);
    if (!ready) return null;
    const lastStartedStage = stagePhases
      .filter((phase) => operation.stages?.[phase])
      .sort(
        (first, second) =>
          operation.stages![first]!.startedAt - operation.stages![second]!.startedAt ||
          stagePhases.indexOf(first) - stagePhases.indexOf(second),
      )
      .at(-1);
    const text = operation.logs.map((line) => `${logTime(line.at)} ${line.message}`).join("\n");
    const copyText = operation.logs.map((line) => `${new Date(line.at).toISOString()} ${line.message}`).join("\n");
    return (
      <NativeDialog isOpen modal close={helmOperations.minimize} className="power-helm-operation-dialog">
        <div
          className="power-helm-operation-content"
          ref={dialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Helm rollback progress"
        >
          <h2 className="power-helm-operation-heading">
            <Icon svg="helm" />
            <span>
              Helm rollback {active ? "in progress" : operation.status === "succeeded" ? "completed" : "failed"}
            </span>
          </h2>
          <div className="power-helm-operation-target">
            <strong className="power-helm-operation-name">{operation.name}</strong>
            <span>{operation.namespace}</span>
            <span className="power-helm-operation-version">Revision {operation.revision}</span>
          </div>
          <ol className="power-helm-operation-stages" aria-live="polite" aria-label="Rollback stages">
            {stagePhases.map((phase, index) => {
              const timing = operation.stages?.[phase];
              const current = active && operation.phase === phase;
              const failed = operation.status === "failed" && phase === lastStartedStage;
              const complete =
                !failed &&
                (timing?.finishedAt !== undefined ||
                  (!operation.stages &&
                    (operation.status === "succeeded" ||
                      index < stagePhases.findIndex((item) => item === operation.phase))));
              const start = timing?.startedAt ?? (current ? operation.startedAt : undefined);
              const end = timing?.finishedAt ?? (current ? now : undefined);
              return (
                <li
                  key={phase}
                  aria-current={current ? "step" : undefined}
                  className={failed ? "is-failed" : complete ? "is-complete" : undefined}
                >
                  <Icon
                    material={
                      failed
                        ? "error"
                        : complete
                          ? "check_circle"
                          : current
                            ? "radio_button_checked"
                            : "radio_button_unchecked"
                    }
                  />
                  <span>{phaseLabels[phase]}</span>
                  {start !== undefined && end !== undefined && (
                    <small className="power-helm-operation-stage-time">{duration(start, end)}</small>
                  )}
                  {current && (
                    <span
                      className="power-helm-operation-spinner power-helm-operation-stage-progress"
                      role="status"
                      aria-label={`${phaseLabels[phase]} in progress`}
                    >
                      <Icon material="sync" />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {operation.error && <p role="alert">{operation.error.message}</p>}
          <details
            className="power-helm-operation-log"
            onToggle={(event) => {
              if (event.currentTarget.open && follow && log.current) log.current.scrollTop = log.current.scrollHeight;
            }}
          >
            <summary tabIndex={0}>Live Helm log ({operation.logs.length} lines)</summary>
            <div className="power-helm-operation-log-toolbar">
              <Checkbox label="Follow log" value={follow} onChange={setFollow} />
              <span role="status" className="power-helm-operation-copy-status">
                {copied ? "Copied" : ""}
              </span>
              <Button
                className="power-helm-operation-copy-button"
                onClick={() => {
                  clipboard.writeText(copyText);
                  setCopied(true);
                }}
              >
                <Icon material="content_copy" size={16} />
                <span>Copy log</span>
              </Button>
            </div>
            <pre
              ref={log}
              onScroll={(event) => {
                const node = event.currentTarget;
                if (node.scrollHeight - node.scrollTop - node.clientHeight > 24) setFollow(false);
              }}
            >
              {text || "Waiting for Helm output…"}
            </pre>
            <small>Only the latest {MAX_LOGS} log lines are retained</small>
          </details>
          <div className="power-helm-operation-footer">
            {!active ? (
              <>
                <Button
                  onClick={() => {
                    helmOperations.minimize();
                    onViewHistory(operation);
                  }}
                >
                  <Icon material="history" />
                  <span>View history</span>
                </Button>

                <Button onClick={helmOperations.minimize}>
                  <Icon material="close" />
                  <span>Close</span>
                </Button>
              </>
            ) : (
              <Button onClick={helmOperations.minimize}>
                <Icon material="minimize" />
                <span>Minimize</span>
              </Button>
            )}
          </div>
        </div>
      </NativeDialog>
    );
  },
);

export const HelmOperationsPanel = observer(
  ({
    clusterId,
    contextId,
    onChanged,
    onViewHistory,
  }: {
    clusterId: string;
    contextId?: string;
    onChanged: () => void;
    onViewHistory: (operation: HelmOperation) => void;
  }) => {
    useEffect(() => subscribe(clusterId, contextId), [clusterId, contextId]);
    const changed = useRef(onChanged);
    changed.current = onChanged;
    const seen = useRef(new Set<string>());
    const operations = helmOperations.operations.filter((item) => matches(item, clusterId, contextId));
    const completed = operations
      .filter(terminal)
      .map((item) => item.requestId)
      .join("|");
    useEffect(() => {
      let update = false;
      for (const item of operations)
        if (terminal(item) && !seen.current.has(item.requestId)) {
          seen.current.add(item.requestId);
          update = true;
        }
      if (update) changed.current();
    }, [completed]);
    const [now, setNow] = useState(Date.now());
    const hasRunning = operations.some((item) => !terminal(item));
    useEffect(() => {
      if (!hasRunning) return;
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [hasRunning]);
    const visible = operations.filter((item) => !terminal(item));
    const latestCompleted = operations
      .filter((item) => terminal(item) && !helmOperations.dismissed.includes(item.requestId))
      .sort((first, second) => (second.finishedAt ?? second.startedAt) - (first.finishedAt ?? first.startedAt))[0];
    if (latestCompleted) visible.push(latestCompleted);
    const selected = operations.find((item) => item.requestId === helmOperations.selectedId);
    return (
      <div className="power-helm-operations">
        <style>{`
      .power-helm-operations .power-helm-operation-card { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px; margin:8px 0; border:1px solid var(--borderColor); border-radius:6px; background:var(--contentColor); }
      .power-helm-operation-card > .power-helm-operation-progress-button { margin-left:auto; }
      .power-helm-operation-dialog { z-index:12000; background:rgb(0 0 0 / 55%); }
      :root .Dialog.power-helm-operation-dialog > .box { background:var(--contentColor); border:1px solid var(--borderColor); border-radius:12px; overflow:hidden; box-shadow:0 20px 70px rgb(0 0 0 / 35%); }
      .power-helm-operation-content { display:flex; flex-direction:column; gap:20px; box-sizing:border-box; padding:28px; width:min(680px,calc(100vw - 48px)); max-height:calc(100vh - 64px); overflow:auto; outline:none; }
      .power-helm-operation-content .power-helm-operation-heading { display:flex; align-items:center; gap:10px; margin:0; font-size:20px; line-height:28px; }
      .power-helm-operation-heading > .Icon { color:var(--primary); flex-shrink:0; }
      .power-helm-operation-target { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
      .power-helm-operation-target > :is(strong,span) { display:inline-flex; align-items:center; box-sizing:border-box; height:22px; padding:1px 7px; border:1px solid var(--borderColor); border-radius:4px; font-size:12px; line-height:18px; }
      .power-helm-operation-target .power-helm-operation-name { font-weight:600; }
      .power-helm-operation-content .power-helm-operation-stages { display:grid; gap:8px; list-style:none; margin:0; padding:14px 16px; border:1px solid var(--borderColor); border-radius:8px; background:var(--mainBackground); }
      .power-helm-operation-stages li { display:flex; align-items:center; gap:10px; min-height:28px; color:var(--textColorSecondary); }
      .power-helm-operation-stages li > .Icon { flex-shrink:0; }
      .power-helm-operation-stages li > .power-helm-operation-stage-time { color:var(--textColorSecondary); font-size:11px; font-weight:400; font-variant-numeric:tabular-nums; }
      .power-helm-operation-stages li > .power-helm-operation-stage-progress { margin-left:auto; }
      .power-helm-operation-stages .is-failed { color:var(--colorError); }
      .power-helm-operation-stages .is-complete,.power-helm-operation-stages [aria-current=step] { color:var(--primary); }
      .power-helm-operation-stages [aria-current=step] { font-weight:600; }
      .power-helm-operation-content .power-helm-operation-log { border:1px solid var(--borderColor); border-radius:8px; overflow:hidden; }
      .power-helm-operation-log > summary { cursor:pointer; padding:14px 16px; font-weight:500; }
      .power-helm-operation-log[open] > summary { border-bottom:1px solid var(--borderColor); }
      .power-helm-operation-log-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:12px 16px; }
      .power-helm-operation-log-toolbar .Checkbox { position:relative; }
      .power-helm-operation-log-toolbar .Checkbox input[type="checkbox"] { display:block; position:absolute; width:1px; height:1px; margin:0; opacity:0; }
      .power-helm-operation-log-toolbar .Checkbox:focus-within > .box { outline:2px solid var(--primary); outline-offset:3px; border-radius:3px; }
      .power-helm-operation-copy-status { margin-left:auto; min-width:42px; color:var(--textColorSecondary); font-size:12px; }
      .power-helm-operation-content .power-helm-operation-log pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; margin:0; padding:14px 16px; background:var(--mainBackground); border-top:1px solid var(--borderColor); user-select:text; font-size:12px; line-height:1.6; }
      .power-helm-operation-log > small { display:block; padding:10px 16px; color:var(--textColorSecondary); font-size:11px; }
      .power-helm-operation-content [role=alert] { margin:0; padding:12px 14px; border:1px solid color-mix(in srgb,var(--colorError) 35%,var(--borderColor)); border-radius:8px; color:var(--colorError); line-height:1.5; }
      .power-helm-operation-footer { display:flex; justify-content:flex-end; align-items:center; gap:10px; padding-top:20px; border-top:1px solid var(--borderColor); }
      .power-helm-operation-content .Button { padding:0 12px; border:1px solid var(--borderColor); border-radius:5px; background:var(--contentColor); color:var(--textColorPrimary); white-space:nowrap; }
      .power-helm-operation-content .Button:hover { border-color:var(--primary); color:var(--primary); }
      @media (max-width:600px) { .power-helm-operation-content { padding:20px; gap:16px; width:calc(100vw - 32px); max-height:calc(100vh - 32px); } }
      .power-helm-operation-content .Button,.power-helm-operations .Button { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; box-sizing:border-box; }
      .power-helm-operation-content .Button.power-helm-operation-copy-button { height:28px; padding:0 8px; font-size:12px; line-height:1; }
      .power-helm-operation-content .Button > .Icon,.power-helm-operations .Button > .Icon { margin:0; padding:0; }
      :root :is(.power-helm-operation-content,.power-helm-operations) .Button { position:relative; }
      :root :is(.power-helm-operation-content,.power-helm-operations) .Button::before { position:absolute; inset:0; pointer-events:none; }
      .power-helm-operation-target .power-helm-operation-version { display:inline-flex; align-items:center; height:22px; box-sizing:border-box; padding:1px 7px; border:1px solid color-mix(in srgb,var(--primary) 25%,var(--borderColor)); background:color-mix(in srgb,var(--primary) 12%,transparent); color:var(--primary); font-size:12px; font-weight:600; }
      :is(.power-helm-operation-content,.power-helm-operations) .power-helm-operation-spinner { display:inline-flex; animation:power-helm-operation-spin 1s linear infinite; vertical-align:middle; }
      @keyframes power-helm-operation-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion:reduce) { :is(.power-helm-operation-content,.power-helm-operations) .power-helm-operation-spinner { animation:none; } }
    `}</style>
        {visible.map((operation) => (
          <div className="power-helm-operation-card" key={operation.requestId} data-request-id={operation.requestId}>
            <span className={operation.status === "running" ? "power-helm-operation-spinner" : undefined}>
              <Icon
                material={
                  operation.status === "running" ? "sync" : operation.status === "succeeded" ? "check_circle" : "error"
                }
              />
            </span>
            <strong>{operation.name}</strong>
            <span>
              {operation.namespace} · Revision {operation.revision}
            </span>
            <span>
              {phaseLabels[operation.phase]} · {elapsed(operation, now)}
            </span>
            <Button
              className="power-helm-operation-progress-button"
              onClick={() => helmOperations.open(operation.requestId)}
            >
              <Icon material="open_in_new" />
              <span>View progress</span>
            </Button>
            {terminal(operation) && (
              <>
                <Button
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onViewHistory(operation);
                  }}
                >
                  <Icon material="history" />
                  <span>View history</span>
                </Button>
                <Button onClick={() => helmOperations.dismiss(operation.requestId)}>
                  <Icon material="close" />
                  <span>Dismiss</span>
                </Button>
              </>
            )}
          </div>
        ))}
        {selected && <OperationDialog key={selected.requestId} operation={selected} onViewHistory={onViewHistory} />}
      </div>
    );
  },
);
