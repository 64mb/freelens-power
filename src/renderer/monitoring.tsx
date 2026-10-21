import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import ReactDOM from "react-dom";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";

export type MonitoringSample = { time: number; cpu: number; memory: number };
const INTERVAL = 30_000;
export const MAX_SAMPLES = 60;

export function parseQuantity(raw: string, memory = false): number {
  const match = /^(\d+(?:\.\d+)?)(n|u|m|Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)?$/.exec(raw);
  if (!match) throw new Error("Invalid metrics quantity");
  const suffix = match[2] ?? "";
  const factors: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
  };
  const value =
    Number(match[1]) *
    (suffix.endsWith("i")
      ? 1024 ** (["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"].indexOf(suffix) + 1)
      : (factors[suffix] ?? 1));
  if (!Number.isFinite(value) || (!memory && suffix.endsWith("i"))) throw new Error("Invalid metrics quantity");
  return value;
}

export function aggregateMetrics(
  nodes: { usage: { cpu: string; memory: string }; timestamp: string }[],
  now = Date.now(),
): MonitoringSample {
  if (!nodes.length) throw new Error("No node metrics available");
  let cpu = 0;
  let memory = 0;
  for (const node of nodes) {
    const timestamp = Date.parse(node.timestamp);
    if (!Number.isFinite(timestamp) || now - timestamp > 120_000 || timestamp > now + 30_000)
      throw new Error("Node metrics are stale");
    cpu += parseQuantity(node.usage.cpu);
    memory += parseQuantity(node.usage.memory, true);
  }
  return { time: now, cpu, memory };
}

function MonitoringCharts({ samples, status }: { samples: MonitoringSample[]; status: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16, marginBottom: 16 }}>
      {(["cpu", "memory"] as const).map((metric) => {
        const last = samples.at(-1);
        const format = (value: number) =>
          metric === "cpu" ? `${value.toFixed(2)} cores` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
        const max = Math.max(...samples.map((sample) => sample[metric]), 0.001) * 1.1;
        const end = last?.time ?? Date.now();
        const start = samples[0]?.time ?? end;
        const points = samples
          .map(
            (sample) =>
              `${8 + ((sample.time - start) / Math.max(end - start, INTERVAL)) * 384},${112 - (sample[metric] / max) * 100}`,
          )
          .join(" ");
        return (
          <section
            key={metric}
            style={{
              padding: 16,
              border: "1px solid var(--borderFaintColor)",
              borderRadius: 8,
              background: "var(--contentColor)",
              minWidth: 0,
            }}
            aria-label={`${metric === "cpu" ? "CPU" : "Memory"} metrics-server usage`}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{metric === "cpu" ? "CPU" : "Memory"}</strong>
              <span>{status ? "Unavailable" : last ? format(last[metric]) : "Collecting…"}</span>
            </div>
            <svg
              viewBox="0 0 400 128"
              role="img"
              aria-label={`${metric} usage over collected samples`}
              style={{ width: "100%", height: 128, color: "var(--primary)" }}
            >
              {[12, 62, 112].map((y) => (
                <line key={y} x1="8" x2="392" y1={y} y2={y} stroke="var(--borderFaintColor)" />
              ))}
              <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
              {samples.map((sample) => (
                <circle
                  key={sample.time}
                  cx={8 + ((sample.time - start) / Math.max(end - start, INTERVAL)) * 384}
                  cy={112 - (sample[metric] / max) * 100}
                  r="2"
                  fill="currentColor"
                >
                  <title>
                    {new Date(sample.time).toLocaleTimeString()}: {format(sample[metric])}
                  </title>
                </circle>
              ))}
            </svg>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                color: "var(--textColorSecondary)",
                fontSize: 11,
              }}
            >
              <span>{samples.length ? new Date(start).toLocaleTimeString() : "Waiting for samples"}</span>
              <span>{samples.length ? new Date(end).toLocaleTimeString() : ""}</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--textColorSecondary)" }} role="status">
              {status || "metrics-server · reported node usage · session samples"}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function startMonitoring(): () => void {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  let stopCurrent: (() => void) | undefined;
  const stop = reaction(
    () => preferences.enabled,
    (enabled) => {
      stopCurrent?.();
      stopCurrent = enabled ? mountMonitoring() : undefined;
    },
    { fireImmediately: true },
  );
  return () => {
    stop();
    stopCurrent?.();
  };
}

function mountMonitoring(): () => void {
  let host: HTMLElement | undefined;
  let overview: Element | null = null;
  let samples: MonitoringSample[] = [];
  let status = "";
  let cluster: string | undefined;
  let stopped = false;
  let pendingGeneration: number | undefined;
  let generation = 0;
  let nextSample = 0;
  const hidden = new Map<HTMLElement, string | null>();
  const restore = () => {
    for (const [element, original] of hidden) {
      if (original === null) element.removeAttribute("style");
      else element.setAttribute("style", original);
    }
    hidden.clear();
    if (host) {
      ReactDOM.unmountComponentAtNode(host);
      host.remove();
      host = undefined;
    }
  };
  const update = async () => {
    const currentCluster = Renderer.Catalog.activeCluster.get()?.metadata.uid;
    const currentOverview = document.querySelector('[data-testid="cluster-overview-page"]');
    if (cluster !== currentCluster || overview !== currentOverview) {
      generation++;
      restore();
      samples = [];
      status = "";
      nextSample = 0;
      cluster = currentCluster;
      overview = currentOverview;
    }
    samples = samples.filter((sample) => sample.time >= Date.now() - MAX_SAMPLES * INTERVAL);
    if (!overview || !cluster || document.visibilityState === "hidden") return;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-freelens-power-monitoring", "");
      overview.prepend(host);
    }
    for (const title of overview.querySelectorAll<HTMLElement>(".PieChart > .chart-title")) {
      if (title.textContent !== "CPU" && title.textContent !== "Memory") continue;
      const panel = title.closest(".PieChart")?.parentElement;
      if (panel && !hidden.has(panel)) {
        hidden.set(panel, panel.getAttribute("style"));
        panel.style.display = "none";
      }
    }
    const render = () => {
      if (host) ReactDOM.render(<MonitoringCharts samples={samples} status={status} />, host);
    };
    render();
    if (pendingGeneration === generation || Date.now() < nextSample) return;
    pendingGeneration = generation;
    nextSample = Date.now() + INTERVAL;
    const requestGeneration = generation;
    const isCurrent = () =>
      !stopped &&
      requestGeneration === generation &&
      document.visibilityState !== "hidden" &&
      overview?.isConnected === true &&
      Renderer.Catalog.activeCluster.get()?.metadata.uid === cluster;
    try {
      const nodes = await Renderer.K8sApi.nodesMetricsApi.list();
      if (!isCurrent()) return;
      samples = [...samples, aggregateMetrics(nodes ?? [])].slice(-MAX_SAMPLES);
      status = "";
    } catch {
      if (!isCurrent()) return;
      status = "Node metrics unavailable, stale or access denied. Last collected samples remain visible.";
    } finally {
      if (pendingGeneration === requestGeneration) pendingGeneration = undefined;
    }
    if (!stopped && requestGeneration === generation) render();
  };
  const timer = window.setInterval(() => {
    void update();
  }, 1000);
  void update();
  return () => {
    stopped = true;
    generation++;
    window.clearInterval(timer);
    restore();
    samples = [];
  };
}
