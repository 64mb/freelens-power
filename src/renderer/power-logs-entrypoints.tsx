import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { observer } from "mobx-react";
import { EXTENSION_ID } from "../common/extension-info";
import { LogsPreferencesStore } from "../common/store/logs-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";

import type { LogTarget, LogWorkloadKind } from "../common/power-logs";

const kinds = new Set<string>(["Pod", "Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Job", "CronJob"]);
const marker = "data-power-logs-target";

function enabled(): boolean {
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  return Boolean(
    clusterId &&
      window.location.protocol === "https:" &&
      window.location.hostname === `${clusterId}.renderer.freelens.app` &&
      LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>().enabled &&
      PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled,
  );
}

export function parsePowerLogsTarget(value: unknown): LogTarget | undefined {
  if (!value || typeof value !== "object") return;
  const target = value as LogTarget;
  if (
    !kinds.has(target.kind) ||
    ![target.name, target.namespace, target.uid].every(
      (part) => typeof part === "string" && part.length > 0 && part.length <= 253 && /^[a-zA-Z0-9_.-]+$/.test(part),
    )
  )
    return;
  return { kind: target.kind, namespace: target.namespace, name: target.name, uid: target.uid };
}

export function openPowerLogs(target: LogTarget, container?: string): void {
  const valid = parsePowerLogsTarget(target);
  if (!valid || !enabled()) return;
  if (container !== undefined && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(container)) return;
  if (container && container.length > 63) return;
  Renderer.Navigation.navigate(
    `/extension/${EXTENSION_ID}/power-logs?target=${encodeURIComponent(JSON.stringify(valid))}${container ? `&container=${encodeURIComponent(container)}` : ""}`,
  );
  window.dispatchEvent(new CustomEvent("power-logs-target", { detail: { ...valid, container } }));
  Renderer.Navigation.hideDetails();
}

function containerStatusClass(
  container: { type?: string },
  status: ReturnType<Renderer.K8sApi.Pod["getContainerStatuses"]>[number],
): string {
  const state = Object.keys(status.state ?? {})[0] ?? "";
  const lastState = Object.keys(status.lastState ?? {})[0];
  if (state === "terminated" || (container.type === "ephemeralContainers" && lastState === "terminated"))
    return "terminated";
  if (container.type === "ephemeralContainers") return "container-ephemeral";
  if (status.ready) return status.restartCount > 0 ? "restarted" : "running";
  return state === "running" ? "waiting" : state;
}

export const PowerLogsMenu = observer(
  ({ object, toolbar }: Renderer.Component.KubeObjectMenuProps<Renderer.K8sApi.KubeObject>) => {
    if (!enabled()) return null;
    const target = parsePowerLogsTarget({
      kind: object.kind as LogWorkloadKind,
      name: object.metadata.name,
      namespace: object.metadata.namespace,
      uid: object.metadata.uid,
    });
    if (!target) return null;
    const containers = target.kind === "Pod" ? (object as Renderer.K8sApi.Pod).getAllContainersWithType() : [];
    const statuses = target.kind === "Pod" ? ((object as Renderer.K8sApi.Pod).getContainerStatuses?.() ?? []) : [];
    const open = (event: React.MouseEvent, container?: string) => {
      event.stopPropagation();
      openPowerLogs(target, container);
    };
    return (
      <Renderer.Component.MenuItem className="power-logs-entry-menu" onClick={(event) => open(event)}>
        <Renderer.Component.Icon material="subject" interactive={toolbar} tooltip="Power Logs" />
        <span className="title" {...{ [marker]: JSON.stringify(target) }}>
          Logs
        </span>
        {containers.length > 0 && (
          <>
            <Renderer.Component.Icon className="arrow" material="keyboard_arrow_right" />
            <Renderer.Component.SubMenu>
              <Renderer.Component.MenuItem onClick={(event) => open(event)}>
                <span>All containers</span>
              </Renderer.Component.MenuItem>
              {containers.map((container) => (
                <Renderer.Component.MenuItem key={container.name} onClick={(event) => open(event, container.name)}>
                  {statuses
                    .filter((status) => status.name === container.name)
                    .map((status) => (
                      <Renderer.Component.StatusBrick
                        key={status.name}
                        className={containerStatusClass(container, status)}
                      />
                    ))}
                  <span>{container.name}</span>
                </Renderer.Component.MenuItem>
              ))}
            </Renderer.Component.SubMenu>
          </>
        )}
        <style>{`.power-logs-entry-menu .SubMenu .MenuItem:hover { background-color:var(--primary)!important; }`}</style>
      </Renderer.Component.MenuItem>
    );
  },
);

export function startPowerLogsEntrypoints(): () => void {
  const hidden = new Map<HTMLElement, { value: string; priority: string; replacement: HTMLElement }>();
  let stopped = false;
  const restore = (element: HTMLElement) => {
    const original = hidden.get(element);
    if (!original) return;
    element.style.setProperty("display", original.value, original.priority);
    if (!original.value) element.style.removeProperty("display");
    hidden.delete(element);
  };
  const synchronize = () => {
    const active = !stopped && enabled();
    for (const [element, state] of hidden) {
      if (!active || !state.replacement.isConnected || !element.isConnected) restore(element);
    }
    if (!active) return;
    for (const label of document.querySelectorAll<HTMLElement>(`[${marker}]`)) {
      const replacement = label.closest<HTMLElement>(".MenuItem");
      if (!replacement?.parentElement) continue;
      for (const sibling of replacement.parentElement.children) {
        if (
          !(sibling instanceof HTMLElement) ||
          sibling === replacement ||
          !sibling.matches(".MenuItem") ||
          sibling.querySelector(`[${marker}]`)
        )
          continue;
        const title = sibling.querySelector(":scope > .title");
        const icon = sibling.querySelector(":scope > .Icon");
        if (title?.textContent?.trim() !== "Logs" || icon?.textContent?.trim() !== "subject") continue;
        if (!hidden.has(sibling))
          hidden.set(sibling, {
            value: sibling.style.getPropertyValue("display"),
            priority: sibling.style.getPropertyPriority("display"),
            replacement,
          });
        if (sibling.style.display !== "none") sibling.style.setProperty("display", "none");
      }
    }
  };
  const click = (event: MouseEvent) => {
    if (!enabled() || !(event.target instanceof Element)) return;
    const icon = event.target.closest(".Icon");
    if (!icon || icon.textContent?.trim() !== "subject" || !icon.closest(".TableCell.logs")) return;
    const row = icon.closest(".TableRow");
    if (!row || !/^\/pods\/?$/.test(window.location.pathname)) return;
    const name = row.querySelector(".TableCell.name")?.textContent?.trim();
    const namespace = row.querySelector(".TableCell.namespace")?.textContent?.trim();
    if (!name || !namespace) return;
    const matches = Renderer.K8sApi.podsStore.items.filter(
      (pod) => pod.getName() === name && pod.getNs() === namespace,
    );
    if (matches.length !== 1 || !matches[0].getAllContainers().length) return;
    const target = parsePowerLogsTarget({ kind: "Pod", name, namespace, uid: matches[0].metadata.uid });
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPowerLogs(target);
  };
  const observer = new MutationObserver(synchronize);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", click, true);
  const stopReaction = reaction(enabled, synchronize, { fireImmediately: true });
  return () => {
    stopped = true;
    observer.disconnect();
    stopReaction();
    document.removeEventListener("click", click, true);
    for (const element of hidden.keys()) restore(element);
  };
}
