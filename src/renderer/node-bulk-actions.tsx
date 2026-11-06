import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  NODE_BULK_CHANNEL,
  NODE_BULK_LIMIT,
  type NodeBulkAction,
  type NodeBulkJob,
  type NodeBulkResponse,
  type NodeBulkTarget,
} from "../common/node-bulk";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { AiIcon } from "./ai-icon";
import { ipcRenderer } from "./ipc";
import { NativeTooltip } from "./native-tooltip";
import { startNodeBulkSelection } from "./node-bulk-selection";
import { renderIntoContainer, unmountContainer } from "./react-roots";

const labels: Record<NodeBulkAction, string> = { cordon: "Cordon", uncordon: "Uncordon", drain: "Drain" };
const icons: Record<NodeBulkAction, string> = {
  cordon: "pause_circle_filled",
  uncordon: "play_circle_filled",
  drain: "delete_sweep",
};
const statusIcons: Record<NodeBulkJob["nodes"][number]["status"], string> = {
  succeeded: "check_circle",
  failed: "error",
  running: "autorenew",
  pending: "schedule",
  cancelled: "cancel",
  skipped: "skip_next",
};

function NodeStatusBadge({ status }: { status: NodeBulkJob["nodes"][number]["status"] }) {
  return (
    <span className="power-node-bulk-status" data-status={status}>
      <AiIcon material={statusIcons[status]} size={14} />
      {status}
    </span>
  );
}

const signature = (nodes: readonly NodeBulkTarget[]) =>
  JSON.stringify(nodes.map((node) => [node.uid, node.name]).sort());

function activeScope(): { clusterId: string; key: string } | undefined {
  const cluster = Renderer.Catalog.activeCluster.get();
  if (
    !cluster ||
    window.location.protocol !== "https:" ||
    window.location.hostname !== `${cluster.metadata.uid}.renderer.freelens.app`
  )
    return;
  return {
    clusterId: cluster.metadata.uid,
    key: JSON.stringify([cluster.metadata.uid, cluster.spec.kubeconfigContext]),
  };
}
function permitted(scope: string): boolean {
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  return (
    power.enabled &&
    power.nodeBulkActions !== false &&
    !ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled &&
    activeScope()?.key === scope
  );
}
async function invoke(clusterId: string, request: object): Promise<NodeBulkResponse> {
  const response = (await ipcRenderer.invoke(NODE_BULK_CHANNEL, { clusterId, ...request })) as NodeBulkResponse;
  if (!response?.ok) throw new Error(response?.error?.message || "Node operation unavailable");
  return response;
}

function NodeActionsMenu({
  disabled,
  count,
  children,
}: {
  disabled: boolean;
  count: number;
  children: import("react").ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.querySelector("button")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const outside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    const reposition = () => close();
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const rect = trigger.current?.getBoundingClientRect();
  return (
    <>
      <div ref={trigger} className="power-node-bulk-trigger">
        <NativeTooltip title={open || disabled ? undefined : `Actions for selected nodes (${count})`}>
          <Renderer.Component.Button
            className="power-node-bulk-fab"
            aria-label={`Actions for ${count} selected nodes`}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen(!open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <span aria-hidden="true">
              <AiIcon material="more_horiz" size={18} />
            </span>
          </Renderer.Component.Button>
        </NativeTooltip>
        <span className="power-node-bulk-count" aria-hidden="true">
          {count}
        </span>
      </div>
      {open &&
        createPortal(
          <ul
            ref={menu}
            role="menu"
            aria-label="Selected node actions"
            className="Menu MenuActions flex power-node-bulk-menu"
            style={{
              position: "fixed",
              right: Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth)),
              bottom: Math.max(8, window.innerHeight - (rect?.top ?? window.innerHeight) + 8),
              margin: 0,
            }}
            onClick={(event) => {
              if ((event.target as Element).closest('[role="menuitem"]:not([aria-disabled="true"])')) close(true);
            }}
            onKeyDown={(event) => {
              const items = [
                ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []),
              ];
              const index = items.indexOf(document.activeElement as HTMLElement);
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === "Tab") close();
              else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                items[next]?.focus();
              }
            }}
          >
            {children}
          </ul>,
          document.body,
        )}
    </>
  );
}

function NodeActionItem({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: import("react").ReactNode;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className={`MenuItem${disabled ? " disabled" : ""}`}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </li>
  );
}

export function NodeBulkToolbar({
  clusterId,
  scope,
  selected,
  onClear,
}: {
  clusterId: string;
  scope: string;
  selected: NodeBulkTarget[];
  onClear(): void;
}) {
  const [job, setJob] = useState<NodeBulkJob>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const jobRef = useRef<NodeBulkJob | undefined>(undefined);
  jobRef.current = job;
  const preparation = useRef(false);
  const running = job?.status === "running";
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const current = jobRef.current;
      if (current?.status === "running")
        void invoke(clusterId, { operation: "cancel", contextId: current.contextId, jobId: current.id }).catch(
          () => {},
        );
    };
  }, [clusterId, scope]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let active = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void invoke(clusterId, { operation: "status", contextId: job.contextId, jobId: job.id })
        .then(
          (response) => {
            if (!active || !alive.current || !response.job) return;
            setJob(response.job);
            if (response.job.status !== "running") {
              onClear();
              if (permitted(scope)) void Renderer.K8sApi.nodesStore.loadAll().catch(() => {});
            }
          },
          () => {
            if (active && alive.current)
              setError("Unable to read operation progress. Refresh nodes to verify their current state.");
          },
        )
        .finally(() => {
          pending = false;
        });
    }, 750);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [clusterId, job?.id, job?.status, scope, onClear]);

  const begin = async (action: NodeBulkAction) => {
    if (preparation.current || running || !selected.length || selected.length > NODE_BULK_LIMIT || !permitted(scope))
      return;
    preparation.current = true;
    setPreparing(true);
    setError("");
    const nodes = selected.map((node) => ({ ...node }));
    const unchanged = () => alive.current && permitted(scope) && signature(nodes) === signature(selectedRef.current);
    try {
      const context = await invoke(clusterId, { operation: "context" });
      if (!context.contextId || !unchanged()) throw new Error();
      const contextId = context.contextId;
      Renderer.Component.ConfirmDialog.open({
        okButtonProps: action === "drain" ? { className: "power-node-bulk-destructive" } : undefined,
        labelOk: (
          <span className="power-node-bulk-confirmation-label">
            <AiIcon material={icons[action]} size={18} />
            <span>{`${labels[action]} ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`}</span>
          </span>
        ),
        message: (
          <div className="power-node-bulk-confirmation">
            <strong>{labels[action]} selected nodes?</strong>
            <p>
              {action === "drain"
                ? "Evicts pods sequentially and respects disruption budgets. Pods requiring force deletion or emptyDir removal block the operation. Stops on the first failure. Completed changes remain."
                : action === "cordon"
                  ? "Marks these nodes unschedulable. Existing pods keep running."
                  : "Allows new pods to be scheduled on these nodes."}
            </p>
            <ul>
              {nodes.map((node) => (
                <li key={node.uid}>
                  <code>{node.name}</code>
                </li>
              ))}
            </ul>
            {action === "drain" && (
              <p>Cancelling stops further work. Nodes may remain cordoned. Refresh nodes before retrying.</p>
            )}
          </div>
        ),
        ok: async () => {
          if (preparation.current) return;
          if (!unchanged() || jobRef.current?.status === "running") {
            if (alive.current) setError("The selection or cluster context changed. Review the nodes and try again.");
            return;
          }
          preparation.current = true;
          setPreparing(true);
          try {
            const response = await invoke(clusterId, { operation: "begin", contextId, action, nodes, confirmed: true });
            if (!response.job) throw new Error();
            if (!alive.current || !permitted(scope)) {
              void invoke(clusterId, { operation: "cancel", contextId, jobId: response.job.id }).catch(() => {});
              return;
            }
            jobRef.current = response.job;
            setJob(response.job);
          } catch {
            if (alive.current)
              setError("Unable to start the node operation. Check access and refresh nodes before retrying.");
          } finally {
            preparation.current = false;
            if (alive.current) setPreparing(false);
          }
        },
      });
    } catch {
      if (alive.current)
        setError("Node operations are unavailable or the selection changed. Check access and try again.");
    } finally {
      preparation.current = false;
      if (alive.current) setPreparing(false);
    }
  };
  const cancel = async () => {
    const current = jobRef.current;
    if (!current || current.status !== "running") return;
    try {
      const response = await invoke(clusterId, {
        operation: "cancel",
        contextId: current.contextId,
        jobId: current.id,
      });
      if (alive.current && response.job) setJob(response.job);
    } catch {
      if (alive.current) setError("Unable to confirm cancellation. Refresh nodes to verify their current state.");
    }
  };
  const completed = job?.nodes.filter((node) => node.status !== "pending" && node.status !== "running").length ?? 0;
  if (!selected.length && !job && !error && !preparing) return null;
  return (
    <section className="power-node-bulk" aria-label="Bulk node actions">
      {selected.length > 0 && (
        <div className="power-node-bulk-floating AddRemoveButtons">
          <NodeActionsMenu disabled={preparing || running} count={selected.length}>
            {(["cordon", "uncordon", "drain"] as const).map((action) => (
              <NodeActionItem
                key={action}
                disabled={preparing || running || selected.length > NODE_BULK_LIMIT}
                onClick={() => void begin(action)}
              >
                <span aria-hidden="true">
                  <AiIcon material={icons[action]} size={18} />
                </span>
                <span className="title">{labels[action]}</span>
              </NodeActionItem>
            ))}
            <NodeActionItem
              onClick={() => {
                onClear();
                setJob(undefined);
                setError("");
              }}
            >
              <span aria-hidden="true">
                <AiIcon material="clear" size={18} />
              </span>
              <span className="title">Clear selection</span>
            </NodeActionItem>
          </NodeActionsMenu>
        </div>
      )}
      {(job || error || preparing || selected.length > NODE_BULK_LIMIT) && (
        <div className="power-node-bulk-panel">
          <div className="power-node-bulk-toolbar">
            {running ? (
              <NativeTooltip title="Cancel remaining">
                <Renderer.Component.Button
                  className="power-node-bulk-panel-action"
                  aria-label="Cancel remaining"
                  onClick={() => void cancel()}
                >
                  <AiIcon material="stop" size={18} />
                </Renderer.Component.Button>
              </NativeTooltip>
            ) : (
              <NativeTooltip title="Dismiss">
                <Renderer.Component.Button
                  className="power-node-bulk-panel-action"
                  aria-label="Dismiss"
                  onClick={() => {
                    setJob(undefined);
                    setError("");
                  }}
                >
                  <AiIcon material="close" size={18} />
                </Renderer.Component.Button>
              </NativeTooltip>
            )}
          </div>
          {selected.length > NODE_BULK_LIMIT && (
            <p role="alert">Select at most {NODE_BULK_LIMIT} nodes per operation.</p>
          )}
          {preparing && <p role="status">Preparing node operation…</p>}
          {error && <p role="alert">{error}</p>}
          {job && (
            <div className="power-node-bulk-progress">
              <p role="status">
                <strong className="power-node-bulk-progress-action">
                  <AiIcon material={icons[job.action]} size={16} />
                  {labels[job.action]}
                </strong>{" "}
                · <NodeStatusBadge status={job.status} /> · {completed} / {job.nodes.length} completed
                {running ? ` · ${Math.floor((Date.now() - job.startedAt) / 1000)}s` : ""}
              </p>
              {running && (
                <div
                  className="power-node-bulk-progress-bar"
                  role="progressbar"
                  aria-label="Node operation progress"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(1, job.nodes.length)}
                  aria-valuenow={completed}
                  aria-valuetext={`${completed} / ${job.nodes.length} completed`}
                >
                  <span style={{ width: `${job.nodes.length ? (completed / job.nodes.length) * 100 : 0}%` }} />
                </div>
              )}
              <details open={job.status !== "succeeded"}>
                <summary>Node results</summary>
                <ul>
                  {job.nodes.map((node) => (
                    <li key={node.uid}>
                      <code>{node.name}</code> · <NodeStatusBadge status={node.status} />
                      {node.message && <> · {node.message}</>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function startNodeBulkActions(): () => void {
  const readOnly = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  let selection: ReturnType<typeof startNodeBulkSelection> | undefined;
  let mount: HTMLDivElement | undefined;
  let selected: NodeBulkTarget[] = [];
  let stopped = false;
  const clear = () => selection?.clear();
  const remove = () => {
    if (mount) {
      unmountContainer(mount);
      mount.remove();
      mount = undefined;
    }
  };
  const style = document.createElement("style");
  style.dataset.freelensPower = "node-bulk";
  style.textContent = `.power-node-bulk{flex-shrink:0}.power-node-bulk-panel{position:relative;padding:5px 10px;border:1px solid var(--borderColor);border-radius:6px;background:var(--contentColor);margin:4px 16px}.power-node-bulk-toolbar{position:absolute;top:5px;right:5px;display:flex;align-items:flex-start;justify-content:flex-end}.power-node-bulk-panel>p,.power-node-bulk-progress>p{padding-right:30px;min-height:18px}.power-node-bulk-progress-action{display:inline-flex;align-items:center;gap:5px;vertical-align:middle}.power-node-bulk-panel .Button.power-node-bulk-panel-action{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--textColorSecondary);box-shadow:none;transition:none}.power-node-bulk-panel .Button.power-node-bulk-panel-action:hover,.power-node-bulk-panel .Button.power-node-bulk-panel-action:focus-visible{background:transparent;color:var(--primary);box-shadow:none}.power-node-bulk-panel .Button.power-node-bulk-panel-action:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.power-node-bulk-panel-action .Icon{color:inherit}.power-node-bulk p{margin:3px 0}.power-node-bulk-progress details{margin:2px 0 2px 20px}.power-node-bulk-progress summary{cursor:pointer}.power-node-bulk-progress ul{margin:3px 0}.power-node-bulk-status{display:inline-flex;align-items:center;gap:3px;vertical-align:middle;padding:1px 5px;border-radius:4px;font-size:11px;line-height:16px;font-weight:400;color:var(--textColorSecondary);background:color-mix(in srgb,currentColor 10%,transparent)}.power-node-bulk-status[data-status=succeeded]{color:var(--colorOk,#4caf50)}.power-node-bulk-status[data-status=failed]{color:var(--colorError,#e74c3c)}.power-node-bulk-status[data-status=running]{color:var(--primary)}.power-node-bulk-status[data-status=skipped]{color:var(--colorWarning,var(--textColorSecondary))}.power-node-bulk-status .Icon{color:inherit}.power-node-bulk-status[data-status=running] .Icon{animation:power-node-bulk-spin 1s linear infinite}.power-node-bulk-progress-bar{height:3px;overflow:hidden;border-radius:2px;background:var(--borderFaintColor);margin:5px 0}.power-node-bulk-progress-bar>span{display:block;height:100%;background:var(--primary)}@keyframes power-node-bulk-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.power-node-bulk-status[data-status=running] .Icon{animation:none}}.power-node-bulk [role=alert]{color:var(--colorError)}.power-node-bulk ul,.power-node-bulk-confirmation ul{max-height:180px;overflow:auto;padding-left:20px}.power-node-bulk-confirmation ul{list-style:disc}.power-node-bulk-confirmation li{display:list-item}.Button.power-node-bulk-destructive,.Button.power-node-bulk-destructive:hover,.Button.power-node-bulk-destructive:focus{background:var(--colorError)!important;color:#fff!important}.power-node-bulk-confirmation-label{display:inline-flex;align-items:center;gap:6px}.power-node-bulk-confirmation code{overflow-wrap:anywhere}.power-node-bulk-trigger{position:relative}.power-node-bulk-menu{padding:4px;min-width:180px}.power-node-bulk-menu button.MenuItem{width:100%;font:inherit;text-align:left;background:var(--bgc);gap:8px}.power-node-bulk-menu button.MenuItem:hover:not(.disabled),.power-node-bulk-menu button.MenuItem:focus:not(.disabled){background:var(--primary);color:var(--freelens-power-accent-foreground,#fff)}.power-node-bulk-count{pointer-events:none;position:absolute;top:-7px;right:-7px;min-width:18px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;background:var(--contentColor);color:var(--textColorPrimary);border:1px solid var(--textColorSecondary)}body:has(.power-node-bulk-floating) .power-ai-launcher{display:none}.Nodes:has(.power-node-bulk-floating) .AddRemoveButtons:not(.power-node-bulk-floating){display:none}`;
  document.head.append(style);
  const stop = reaction(
    () => [readOnly.enabled, power.nodeBulkActions, activeScope()?.key],
    () => {
      selection?.stop();
      selection = undefined;
      selected = [];
      remove();
      const scope = activeScope();
      if (stopped || readOnly.enabled || power.nodeBulkActions === false || !scope) return;
      const show = () => {
        if (mount)
          renderIntoContainer(
            <NodeBulkToolbar clusterId={scope.clusterId} scope={scope.key} selected={selected} onClear={clear} />,
            mount,
          );
      };
      selection = startNodeBulkSelection({
        getContext: () => activeScope()?.key ?? "",
        getNodes: () =>
          Renderer.K8sApi.nodesStore.contextItems.map((node) => ({ uid: node.getId(), name: node.getName() })),
        onChange: (nodes) => {
          selected = nodes;
          show();
        },
        onTable: (table) => {
          remove();
          if (table) {
            mount = document.createElement("div");
            mount.dataset.powerNodeBulkToolbar = "";
            table.before(mount);
            show();
          }
        },
      });
    },
    { fireImmediately: true },
  );
  return () => {
    stopped = true;
    stop();
    selection?.stop();
    remove();
    style.remove();
  };
}
