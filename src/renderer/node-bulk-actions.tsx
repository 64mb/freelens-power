import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { reaction } from "mobx";
import { useEffect, useRef, useState } from "react";
import { createPortal, render, unmountComponentAtNode } from "react-dom";
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
import { startNodeBulkSelection } from "./node-bulk-selection";

const labels: Record<NodeBulkAction, string> = { cordon: "Cordon", uncordon: "Uncordon", drain: "Drain" };
const icons: Record<NodeBulkAction, string> = {
  cordon: "pause_circle_filled",
  uncordon: "play_circle_filled",
  drain: "delete_sweep",
};
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
  return (
    PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled &&
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
      <div ref={trigger}>
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
          <span className="power-node-bulk-count" aria-hidden="true">
            {count}
          </span>
        </Renderer.Component.Button>
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
  const jobRef = useRef<NodeBulkJob>();
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
        labelOk: `${labels[action]} ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"}`,
        message: (
          <div className="power-node-bulk-confirmation">
            <strong>{labels[action]} selected nodes?</strong>
            <p>
              {action === "drain"
                ? "Evicts pods one node at a time, respecting disruption budgets. Pods requiring force deletion or emptyDir data removal will block the operation. Stops on the first failure; completed changes remain."
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
              <p>Cancelling stops further work; affected nodes may remain cordoned. Refresh nodes before retrying.</p>
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
            <strong>{job ? `${labels[job.action]} nodes` : `${selected.length} selected`}</strong>
            {running ? (
              <Renderer.Component.Button onClick={() => void cancel()}>Cancel remaining</Renderer.Component.Button>
            ) : (
              <Renderer.Component.Button
                onClick={() => {
                  setJob(undefined);
                  setError("");
                }}
              >
                Dismiss
              </Renderer.Component.Button>
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
                {labels[job.action]} · {job.status} · {job.nodes.filter((node) => node.status === "succeeded").length} /{" "}
                {job.nodes.length} completed{running ? ` · ${Math.floor((Date.now() - job.startedAt) / 1000)}s` : ""}
              </p>
              <details open={job.status !== "succeeded"}>
                <summary>Node results</summary>
                <ul>
                  {job.nodes.map((node) => (
                    <li key={node.uid}>
                      <code>{node.name}</code> · {node.status}
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
  let selection: ReturnType<typeof startNodeBulkSelection> | undefined;
  let mount: HTMLDivElement | undefined;
  let selected: NodeBulkTarget[] = [];
  let stopped = false;
  const clear = () => selection?.clear();
  const remove = () => {
    if (mount) {
      unmountComponentAtNode(mount);
      mount.remove();
      mount = undefined;
    }
  };
  const style = document.createElement("style");
  style.dataset.freelensPower = "node-bulk";
  style.textContent = `.power-node-bulk{flex-shrink:0}.power-node-bulk-panel{padding:8px 12px;border:1px solid var(--borderColor);border-radius:6px;background:var(--contentColor);margin:4px 0}.power-node-bulk-toolbar{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}.power-node-bulk-panel .Button{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;min-height:30px}.power-node-bulk p{margin:6px 0}.power-node-bulk [role=alert]{color:var(--colorError)}.power-node-bulk ul,.power-node-bulk-confirmation ul{max-height:180px;overflow:auto;padding-left:20px}.power-node-bulk-confirmation code{overflow-wrap:anywhere}.power-node-bulk-floating .Button.power-node-bulk-fab{position:relative;overflow:visible;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border-radius:6px;border:1px solid color-mix(in srgb,var(--borderColor) 75%,var(--textColorSecondary) 25%);background:var(--contentColor);color:var(--textColorSecondary);box-shadow:none;transition:color 160ms ease,border-color 160ms ease}.power-node-bulk-floating .Button.power-node-bulk-fab:hover{color:var(--textColorAccent);border-color:var(--textColorAccent);background:color-mix(in srgb,var(--contentColor) 92%,var(--primary) 8%)}.power-node-bulk-floating .Button.power-node-bulk-fab:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.power-node-bulk-menu{padding:4px;min-width:180px}.power-node-bulk-menu button.MenuItem{width:100%;font:inherit;text-align:left;background:var(--bgc);gap:8px}.power-node-bulk-menu button.MenuItem:hover:not(.disabled),.power-node-bulk-menu button.MenuItem:focus{background:var(--menuActiveBackground);color:white}.power-node-bulk-count{position:absolute;top:-7px;right:-7px;min-width:18px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;background:var(--contentColor);color:var(--textColorPrimary);border:1px solid var(--textColorSecondary)}body:has(.power-node-bulk-floating) .power-ai-launcher{display:none}.Nodes:has(.power-node-bulk-floating) .AddRemoveButtons:not(.power-node-bulk-floating){display:none}@media(prefers-reduced-motion:reduce){.power-node-bulk-floating .Button.power-node-bulk-fab{transition:none}}`;
  document.head.append(style);
  const stop = reaction(
    () => [readOnly.enabled, activeScope()?.key],
    () => {
      selection?.stop();
      selection = undefined;
      selected = [];
      remove();
      const scope = activeScope();
      if (stopped || readOnly.enabled || !scope) return;
      const show = () => {
        if (mount)
          render(
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
