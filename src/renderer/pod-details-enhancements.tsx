import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import ReactDOM from "react-dom";

const cellMarker = "data-power-pod-name";
const hoverMarker = "data-power-pod-name-hover";
const selector =
  ".KubeObjectDetails :is(.DeploymentDetails, .ReplicaSetDetails, .StatefulSetDetails, .DaemonSetDetails, .JobDetails, .CronJobDetails, .ReplicationControllerDetails) .PodDetailsList .TableRow .TableCell.name a[href]";

type Mounted = {
  host: HTMLSpanElement;
  cell: HTMLElement;
  badges: Element[];
  signature: string;
};

function podPath(link: HTMLAnchorElement): string | undefined {
  try {
    const path = new URL(link.href, window.location.href).searchParams.get("kube-details");
    return path && /^\/api\/v1\/namespaces\/[^/]+\/pods\/[^/]+$/.test(path) ? path : undefined;
  } catch {
    return;
  }
}

export function startPodDetailsEnhancements(): () => void {
  if (process.isMainFrame !== false) return () => {};
  const mounted = new Map<HTMLAnchorElement, Mounted>();
  const style = document.createElement("style");
  style.dataset.freelensPower = "pod-details-enhancements";
  style.textContent = `
    [${cellMarker}] > .power-pod-status { display:inline-flex;align-items:center;vertical-align:middle;margin-right:8px; }
    [${cellMarker}] > .power-pod-status .StatusBrick { margin-right:0; }
    [${hoverMarker}]:hover { background-color:transparent!important; }
  `;
  document.head.append(style);
  let stopped = false;
  let scheduled = false;
  const remove = (link: HTMLAnchorElement, item: Mounted) => {
    ReactDOM.unmountComponentAtNode(item.host);
    item.host.remove();
    item.cell.removeAttribute(cellMarker);
    for (const badge of item.badges) badge.removeAttribute(hoverMarker);
    mounted.delete(link);
  };
  const update = () => {
    scheduled = false;
    if (stopped) return;
    const pods = new Map(Renderer.K8sApi.podsStore.items.map((pod) => [pod.selfLink, pod]));
    const links = new Set(document.querySelectorAll<HTMLAnchorElement>(selector));
    for (const [link, item] of mounted) {
      if (!links.has(link) || !pods.has(podPath(link) ?? "")) remove(link, item);
    }
    for (const link of links) {
      const path = podPath(link);
      const pod = path ? pods.get(path) : undefined;
      const cell = link.closest<HTMLElement>(".TableCell.name");
      if (!pod || !cell) continue;
      let item = mounted.get(link);
      if (!item) {
        const host = document.createElement("span");
        host.className = "power-pod-status";
        const badges = [link.parentElement, link.firstElementChild].filter(
          (element): element is HTMLElement => !!element && element !== cell,
        );
        item = { host, cell, badges, signature: "" };
        cell.setAttribute(cellMarker, "");
        for (const badge of badges) badge.setAttribute(hoverMarker, "");
        cell.prepend(host);
        mounted.set(link, item);
      }
      const status = pod.getStatus();
      const message = pod.getStatusMessage();
      const signature = JSON.stringify([path, status, message]);
      if (signature === item.signature) continue;
      item.signature = signature;
      ReactDOM.render(<Renderer.Component.StatusBrick className={status.toLowerCase()} tooltip={message} />, item.host);
    }
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(update);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  const stopReaction = reaction(
    () => [
      Renderer.Catalog.activeCluster.get()?.metadata.uid,
      Renderer.K8sApi.podsStore.items.map((pod) => [pod.selfLink, pod.getStatus(), pod.getStatusMessage()]),
    ],
    schedule,
    { fireImmediately: true },
  );
  return () => {
    stopped = true;
    observer.disconnect();
    stopReaction();
    for (const [link, item] of mounted) remove(link, item);
    style.remove();
  };
}
