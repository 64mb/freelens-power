import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import ReactDOM from "react-dom";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import {
  effectivePodResource,
  MAX_SAMPLES,
  MetricChart,
  type MonitoringPod,
  type MonitoringSample,
  parseQuantity,
} from "./monitoring";

type PodIdentity = { name: string; namespace: string };
type PodMetrics = {
  metadata: PodIdentity & { uid?: string };
  timestamp: string;
  containers: { name: string; usage: { cpu: string; memory: string } }[];
};
const INTERVAL = 30_000;

export function aggregatePodMetrics(metrics: PodMetrics, identity: PodIdentity, now = Date.now()): MonitoringSample {
  if (metrics.metadata?.name !== identity.name || metrics.metadata?.namespace !== identity.namespace)
    throw new Error("Pod metrics identity changed");
  const time = Date.parse(metrics.timestamp);
  if (!Number.isFinite(time) || now - time > 120_000 || time > now + 30_000) throw new Error("Pod metrics are stale");
  if (!metrics.containers?.length) throw new Error("Missing container metrics");
  const names = new Set<string>();
  let cpu = 0;
  let memory = 0;
  for (const container of metrics.containers) {
    if (!container.name || names.has(container.name)) throw new Error("Invalid container metrics");
    names.add(container.name);
    cpu += parseQuantity(container.usage.cpu);
    memory += parseQuantity(container.usage.memory, true);
  }
  return { time, cpu, memory };
}

function selectedPod(): PodIdentity | undefined {
  const details = new URLSearchParams(window.location.search).get("kube-details");
  const match = details?.match(/^\/api\/v1\/namespaces\/([a-z0-9][a-z0-9.-]*)\/pods\/([a-z0-9][a-z0-9.-]*)$/);
  if (match) return { namespace: match[1], name: match[2] };
  return;
}

function visible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      node.hidden ||
      node.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false;
  }
  return true;
}

export function startPodMonitoring(): () => void {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  let dispose: (() => void) | undefined;
  const stop = reaction(
    () => preferences.enabled,
    (enabled) => {
      dispose?.();
      dispose = enabled ? mountPodMonitoring() : undefined;
    },
    { fireImmediately: true },
  );
  return () => {
    stop();
    dispose?.();
  };
}

function mountPodMonitoring(): () => void {
  let stopped = false;
  let generation = 0;
  let session = "";
  let samples: MonitoringSample[] = [];
  let status = "";
  let resourceUid: string | undefined;
  let nextRead = 0;
  let pending: number | undefined;
  let host: HTMLElement | undefined;
  let graph: HTMLElement | undefined;
  let originalStyle: string | null = null;
  let renderedSamples: MonitoringSample[] | undefined;
  let renderedStatus: string | undefined;
  let renderedMetric: string | undefined;
  const restore = () => {
    if (host) {
      ReactDOM.unmountComponentAtNode(host);
      host.remove();
    }
    host = undefined;
    if (graph) {
      if (originalStyle === null) graph.removeAttribute("style");
      else graph.setAttribute("style", originalStyle);
    }
    graph = undefined;
    renderedSamples = undefined;
  };
  const reset = () => {
    generation++;
    session = "";
    samples = [];
    resourceUid = undefined;
    status = "";
    nextRead = 0;
    restore();
  };
  const update = async () => {
    if (stopped) return;
    const identity = selectedPod();
    const cluster = Renderer.Catalog.activeCluster.get()?.metadata.uid;
    const drawer = document.querySelector<HTMLElement>(".KubeObjectDetails");
    const title = drawer?.querySelector(".drawer-title-text");
    const titleText = title
      ? [...title.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim()
      : "";
    if (
      !identity ||
      !cluster ||
      !drawer ||
      !visible(drawer) ||
      document.visibilityState === "hidden" ||
      titleText !== `Pod: ${identity.name}` ||
      !drawer.querySelector(".PodDetails")
    ) {
      if (session) reset();
      return;
    }
    const key = JSON.stringify([cluster, identity.namespace, identity.name]);
    if (session !== key) {
      reset();
      session = key;
    }
    const metrics = [...drawer.querySelectorAll<HTMLElement>(".ResourceMetrics")].find((element) =>
      ["CPU", "Memory", "Network", "Filesystem"].every((label) =>
        [...element.querySelectorAll(".Radio .label")].some((node) => node.textContent === label),
      ),
    );
    const selected = metrics?.querySelector(".Radio.checked .label")?.textContent;
    const nativeGraph = metrics?.querySelector<HTMLElement>(":scope > .graph");
    if (!metrics || !visible(metrics) || !nativeGraph || (selected !== "CPU" && selected !== "Memory")) {
      restore();
      return;
    }
    const retained = samples.filter((sample) => sample.time >= Date.now() - 30 * 60_000);
    if (retained.length !== samples.length) samples = retained;
    const metric = selected === "CPU" ? "cpu" : "memory";
    if (graph !== nativeGraph || !host?.isConnected) {
      restore();
      graph = nativeGraph;
      originalStyle = graph.getAttribute("style");
      graph.style.display = "none";
      host = document.createElement("div");
      host.dataset.powerPodMonitoring = "";
      graph.after(host);
    }
    const render = () => {
      if (host && (renderedSamples !== samples || renderedStatus !== status || renderedMetric !== metric)) {
        ReactDOM.render(<MetricChart metric={metric} samples={samples} status={status} scope="pod" />, host);
        renderedSamples = samples;
        renderedStatus = status;
        renderedMetric = metric;
      }
    };
    render();
    if (pending === generation || Date.now() < nextRead) return;
    const current = generation;
    pending = current;
    nextRead = Date.now() + INTERVAL;
    const isCurrent = () =>
      !stopped &&
      current === generation &&
      session === key &&
      drawer.isConnected &&
      visible(drawer) &&
      document.visibilityState !== "hidden" &&
      Renderer.Catalog.activeCluster.get()?.metadata.uid === cluster &&
      JSON.stringify(selectedPod()) === JSON.stringify(identity);
    try {
      const [usage, pod] = await Promise.allSettled([
        Promise.resolve().then(() =>
          Renderer.K8sApi.podsMetricsApi.list(
            { namespace: identity.namespace },
            { fieldSelector: `metadata.name=${identity.name}` },
          ),
        ),
        Promise.resolve().then(() => Renderer.K8sApi.podsApi.get(identity)),
      ]);
      if (!isCurrent()) return;
      const currentPod =
        pod.status === "fulfilled" &&
        pod.value?.metadata.name === identity.name &&
        pod.value.metadata.namespace === identity.namespace
          ? pod.value
          : undefined;
      if (currentPod) {
        const nextUid = currentPod.metadata.uid;
        if (nextUid && resourceUid && nextUid !== resourceUid) samples = [];
        if (nextUid) resourceUid = nextUid;
      }
      if (usage.status !== "fulfilled" || !Array.isArray(usage.value)) throw new Error("Metrics unavailable");
      const matches = usage.value.filter(
        (item) => item.metadata?.name === identity.name && item.metadata.namespace === identity.namespace,
      );
      if (matches.length !== 1) throw new Error("Metrics unavailable");
      const podMetrics = matches[0];
      const sample = aggregatePodMetrics(podMetrics, identity);
      if (currentPod) {
        const created = currentPod.metadata.creationTimestamp;
        if (created !== undefined) {
          const creationTime = Date.parse(created);
          if (!Number.isFinite(creationTime)) throw new Error("Invalid pod creation time");
          samples = samples.filter((entry) => entry.time >= creationTime);
          if (sample.time < creationTime) throw new Error("Pod metrics predate the current pod");
        }
        if (podMetrics.metadata.uid && resourceUid && podMetrics.metadata.uid !== resourceUid)
          throw new Error("Pod metrics identity changed");
        try {
          const spec: MonitoringPod = currentPod;
          sample.resources = Object.fromEntries(
            (["cpu", "memory"] as const).map((resource) => {
              const limits = effectivePodResource(spec, resource, "limits");
              return [
                resource,
                {
                  requests: effectivePodResource(spec, resource, "requests"),
                  limits: Number.isFinite(limits) ? limits : undefined,
                  unbounded: limits === Infinity,
                },
              ];
            }),
          ) as MonitoringSample["resources"];
        } catch {
          sample.resourceStatus = "Pod requests and limits unavailable: incomplete resource data";
        }
      } else sample.resourceStatus = "Pod requests and limits unavailable or access denied";
      samples = [
        ...samples.filter((entry) => entry.time !== sample.time && entry.time >= Date.now() - 30 * 60_000),
        sample,
      ]
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_SAMPLES);
      status = "";
    } catch {
      if (!isCurrent()) return;
      status = "Pod metrics unavailable, stale or access denied. Last collected samples remain visible.";
    } finally {
      if (pending === current) pending = undefined;
    }
    if (isCurrent()) void update();
  };
  const timer = window.setInterval(() => {
    void update();
  }, 1000);
  void update();
  return () => {
    stopped = true;
    reset();
    window.clearInterval(timer);
  };
}
