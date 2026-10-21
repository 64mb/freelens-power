import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";

type ResourceValues = { requests?: Partial<Record<string, string>>; limits?: Partial<Record<string, string>> };
type ResourceContainer = { resources?: ResourceValues; restartPolicy?: string };
export type MonitoringPod = {
  spec?: {
    nodeName?: string;
    containers?: ResourceContainer[];
    initContainers?: ResourceContainer[];
    overhead?: Partial<Record<string, string>>;
    resources?: ResourceValues;
  };
  status?: { phase?: string };
};
export type MonitoringNode = {
  metadata: { name: string };
  status?: { capacity?: Partial<Record<string, string>>; allocatable?: Partial<Record<string, string>> };
};
type ResourceTotals = {
  capacity?: number;
  allocatable?: number;
  requests?: number;
  limits?: number;
  unbounded?: boolean;
};
export type MonitoringSample = {
  time: number;
  cpu: number;
  memory: number;
  resources?: Record<"cpu" | "memory", ResourceTotals>;
  resourceStatus?: string;
  completeUsage?: boolean;
};

export function effectivePodResource(
  pod: MonitoringPod,
  metric: "cpu" | "memory",
  kind: "requests" | "limits",
): number {
  const read = (resources?: ResourceValues) => {
    const raw = resources?.[kind]?.[metric];
    if (raw !== undefined) return parseQuantity(raw, metric === "memory");
    if (kind === "requests" && resources?.limits?.[metric] !== undefined)
      return parseQuantity(resources.limits[metric], metric === "memory");
    return kind === "requests" ? 0 : Infinity;
  };
  const spec = pod.spec;
  if (!spec?.containers?.length) throw new Error("Missing pod containers");
  let sidecars = 0;
  let initPeak = 0;
  for (const container of spec.initContainers ?? []) {
    const value = read(container.resources);
    if (container.restartPolicy === "Always") {
      sidecars += value;
      initPeak = Math.max(initPeak, sidecars);
    } else initPeak = Math.max(initPeak, sidecars + value);
  }
  let effective = Math.max(
    initPeak,
    sidecars + spec.containers.reduce((sum, container) => sum + read(container.resources), 0),
  );
  if (spec.resources?.[kind]?.[metric] !== undefined) effective = read(spec.resources);
  const overhead = spec.overhead?.[metric];
  if (overhead !== undefined && (kind === "requests" || effective > 0))
    effective += parseQuantity(overhead, metric === "memory");
  return effective;
}

export function aggregateResources(
  nodes: MonitoringNode[],
  pods?: MonitoringPod[],
): Record<"cpu" | "memory", ResourceTotals> {
  if (!nodes.length || nodes.some((node) => !node.metadata?.name)) throw new Error("Missing node inventory");
  const names = new Set(nodes.map((node) => node.metadata.name));
  const scheduled = pods?.filter(
    (pod) =>
      pod.spec?.nodeName &&
      names.has(pod.spec.nodeName) &&
      pod.status?.phase !== "Succeeded" &&
      pod.status?.phase !== "Failed",
  );
  const sum = (metric: "cpu" | "memory"): ResourceTotals => {
    const capacity = nodes.reduce(
      (total, node) => total + parseQuantity(node.status?.capacity?.[metric] ?? "", metric === "memory"),
      0,
    );
    const allocatable = nodes.reduce(
      (total, node) => total + parseQuantity(node.status?.allocatable?.[metric] ?? "", metric === "memory"),
      0,
    );
    const requests = scheduled?.reduce((total, pod) => total + effectivePodResource(pod, metric, "requests"), 0);
    const limits = scheduled?.reduce((total, pod) => total + effectivePodResource(pod, metric, "limits"), 0);
    return {
      capacity,
      allocatable,
      requests,
      limits: limits === Infinity ? undefined : limits,
      unbounded: limits === Infinity,
    };
  };
  return { cpu: sum("cpu"), memory: sum("memory") };
}
const INTERVAL = 30_000;
export const MAX_SAMPLES = 60;

export function parseQuantity(raw: string, memory = false): number {
  const match = /^(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|n|u|m|Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E)?$/.exec(raw);
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
      : /^[eE][+-]?\d+$/.test(suffix)
        ? 10 ** Number(suffix.slice(1))
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

export function formatMonitoringTime(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function ResourceTitle({ metric, label }: { metric: "cpu" | "memory"; label?: string }) {
  return (
    <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="Icon material" aria-hidden="true" style={{ "--size": "18px", fontWeight: 400 } as CSSProperties}>
        <span className="icon">{metric === "cpu" ? "developer_board" : "memory"}</span>
      </span>
      {label ?? (metric === "cpu" ? "CPU" : "Memory")}
    </strong>
  );
}

export function MetricChart({
  metric,
  samples,
  status,
  scope = "node",
}: {
  metric: "cpu" | "memory";
  samples: MonitoringSample[];
  status: string;
  scope?: "node" | "pod";
}) {
  const [selectedTime, setSelectedTime] = useState<number>();
  const [pinned, setPinned] = useState(false);
  const previousMetric = useRef(metric);
  useEffect(() => {
    if (
      previousMetric.current !== metric ||
      (selectedTime !== undefined && !samples.some((sample) => sample.time === selectedTime))
    ) {
      setPinned(false);
      setSelectedTime(undefined);
    }
    previousMetric.current = metric;
  }, [metric, samples, selectedTime]);
  useEffect(() => {
    if (!pinned) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPinned(false);
        setSelectedTime(undefined);
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [pinned]);
  const chartRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const measure = () => {
      const measured = chart.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(chart);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const plotWidth = Math.max(1, width - 112);
  const last = samples.at(-1);
  const selected = samples.find((sample) => sample.time === selectedTime);
  const label = metric === "cpu" ? "CPU" : "Memory";
  const format = (value: number) =>
    metric === "cpu" ? `${value.toFixed(2)} cores` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
  const series = [
    { key: "usage", label: "Usage", color: "#c93dce", value: (sample: MonitoringSample) => sample[metric] },
    ...(["requests", "allocatable", "capacity"] as const).map((key) => ({
      key,
      label: { requests: "Requests", allocatable: "Allocatable Capacity", capacity: "Capacity" }[key],
      color: { requests: "#4caf50", allocatable: "#5486b5", capacity: "var(--textColorSecondary)" }[key],
      value: (sample: MonitoringSample) => sample.resources?.[metric][key],
    })),
  ];
  const max = Math.max(...samples.flatMap((sample) => series.map((line) => line.value(sample) ?? 0)), 0.001) * 1.1;
  const end = last?.time ?? Date.now();
  const start = samples[0]?.time ?? end;
  const duration = Math.max(end - start, INTERVAL);
  const x = (sample: MonitoringSample) => 88 + ((sample.time - start) / duration) * plotWidth;
  const y = (sample: MonitoringSample) => 208 - (sample[metric] / max) * 184;
  const selectNearest = (event: React.MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !samples.length) return;
    const scale = Math.min(bounds.width / width, (bounds.height || 250) / 250);
    const offset = (bounds.width - width * scale) / 2;
    const position = (event.clientX - bounds.left - offset) / scale;
    const time = start + ((position - 88) / plotWidth) * duration;
    const nearest = samples.reduce((nearest, sample) =>
      Math.abs(sample.time - time) < Math.abs(nearest.time - time) ? sample : nearest,
    ).time;
    setSelectedTime(nearest);
    return nearest;
  };
  return (
    <section
      aria-label={`${label} metrics-server usage`}
      style={{
        padding: "var(--power-monitoring-trend-top, 16px) 16px 16px",
        background: "var(--contentColor)",
        minWidth: 0,
        minHeight: 280,
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ResourceTitle metric={metric} />
        <span>{status ? "Unavailable" : last ? format(last[metric]) : "Collecting…"}</span>
      </div>
      <svg
        ref={chartRef}
        data-monitoring-trend=""
        viewBox={`0 0 ${width} 250`}
        role="img"
        tabIndex={0}
        aria-label={`${label} usage over collected samples. Use arrow keys to inspect samples. Click or press Enter to pin the tooltip, Escape to dismiss`}
        onMouseMove={(event) => {
          if (!pinned) selectNearest(event);
        }}
        onClick={(event) => {
          if (pinned) setPinned(false);
          else if (samples.length) {
            if (selectNearest(event) === undefined && !selected) setSelectedTime(last?.time);
            setPinned(true);
          }
        }}
        onMouseLeave={() => {
          if (!pinned) setSelectedTime(undefined);
        }}
        onFocus={() => {
          if (!pinned) setSelectedTime(last?.time);
        }}
        onBlur={() => {
          if (!pinned) setSelectedTime(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (samples.length) {
              if (!selected) setSelectedTime(last?.time);
              setPinned(!pinned);
            }
            return;
          }
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const index = samples.findIndex((sample) => sample.time === selectedTime);
          setSelectedTime(
            samples[
              Math.max(
                0,
                Math.min(
                  samples.length - 1,
                  (index < 0 ? samples.length - 1 : index) + (event.key === "ArrowLeft" ? -1 : 1),
                ),
              )
            ]?.time,
          );
        }}
        style={{ width: "100%", height: 250, color: "#c93dce", display: "block" }}
      >
        <title>Click to pin tooltip · click again or Escape to unpin</title>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1="88"
              x2={width - 24}
              y1={208 - fraction * 184}
              y2={208 - fraction * 184}
              stroke="var(--borderFaintColor)"
            />
            <text x="80" y={212 - fraction * 184} textAnchor="end" fill="var(--textColorSecondary)" fontSize="11">
              {format(max * fraction)}
            </text>
          </g>
        ))}
        {series.map((line) => (
          <path
            key={line.key}
            data-monitoring-series={line.key}
            d={samples.reduce((path, sample, index) => {
              const value = line.value(sample);
              if (value === undefined) return path;
              const previous = index ? line.value(samples[index - 1]) : undefined;
              return `${path} ${previous === undefined ? "M" : "L"}${x(sample)},${208 - (value / max) * 184}`;
            }, "")}
            fill="none"
            stroke={line.color}
            strokeWidth="2"
            strokeDasharray={line.key === "capacity" || line.key === "allocatable" ? "5 3" : undefined}
          />
        ))}
        {samples.map((sample) => (
          <circle key={sample.time} cx={x(sample)} cy={y(sample)} r="2" fill="currentColor">
            <title>
              {formatMonitoringTime(sample.time)}: {format(sample[metric])}
            </title>
          </circle>
        ))}
        {samples.length > 0 &&
          [0, 0.5, 1].map((fraction) => (
            <text
              key={fraction}
              x={88 + fraction * plotWidth}
              y="235"
              textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}
              fill="var(--textColorSecondary)"
              fontSize="11"
            >
              {formatMonitoringTime(start + fraction * duration)}
            </text>
          ))}
        {selected && (
          <line
            data-monitoring-crosshair=""
            x1={x(selected)}
            x2={x(selected)}
            y1="24"
            y2="208"
            stroke="var(--textColorSecondary)"
            strokeDasharray="4 3"
          />
        )}
      </svg>
      <style>{`
        @keyframes freelens-power-metric-tooltip-enter { from { opacity:0; transform:translateY(2px) } to { opacity:1; transform:translateY(0) } }
        [data-monitoring-tooltip] { animation:freelens-power-metric-tooltip-enter 140ms ease-out }
        @media (prefers-reduced-motion:reduce) { [data-monitoring-tooltip] { animation:none } }
      `}</style>
      {selected && (
        <div
          data-monitoring-tooltip=""
          role="tooltip"
          style={{
            position: "absolute",
            top: 44,
            right: 24,
            padding: 8,
            background: "var(--contentColor)",
            border: "1px solid var(--borderFaintColor)",
            pointerEvents: "none",
          }}
        >
          <div>
            {formatMonitoringTime(selected.time)}
            {pinned ? " · Pinned" : ""}
          </div>
          {series.map((line) => (
            <div key={line.key} style={{ color: line.color }}>
              {line.label}: {line.value(selected) === undefined ? "Unavailable" : format(line.value(selected)!)}
            </div>
          ))}
          <div style={{ color: "var(--textColorSecondary)", marginTop: 4, fontSize: 10 }}>
            {pinned ? "Click chart or Escape to unpin" : "Click or Enter to pin"}
          </div>
        </div>
      )}
      <div
        aria-label={`${label} chart legend`}
        style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginBottom: 8 }}
      >
        {series.map((line) => (
          <span key={line.key}>
            <span style={{ color: line.color }}>●</span> {line.label}
          </span>
        ))}
      </div>
      {last?.resourceStatus && (
        <div role="status" style={{ color: "var(--textColorSecondary)", marginBottom: 8 }}>
          {last.resourceStatus}
        </div>
      )}
      <div
        style={{ fontSize: 11, color: "var(--textColorSecondary)", display: "flex", alignItems: "center", gap: 4 }}
        role="status"
        aria-label={`${scope} metrics status`}
      >
        <sup aria-hidden="true" style={{ fontSize: 12 }}>
          *
        </sup>
        <span>{status || (samples.length ? "metrics-server data" : "Waiting for metrics-server data")}</span>
      </div>
    </section>
  );
}

function ResourceDonut({
  metric,
  sample,
  status,
}: {
  metric: "cpu" | "memory";
  sample?: MonitoringSample;
  status: string;
}) {
  const [activeRing, setActiveRing] = useState<number>();
  useEffect(() => {
    if (activeRing === undefined) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setActiveRing(undefined);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [activeRing]);
  const label = metric === "cpu" ? "CPU" : "Memory";
  const totals = sample?.resources?.[metric];
  const format = (value: number) =>
    metric === "cpu" ? `${value.toFixed(2)} cores` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
  const available = (value?: number) => (value === undefined ? "Unavailable" : format(value));
  const denominator = totals?.allocatable;
  const rings = [
    { label: "Usage", color: "#c93dce", value: sample?.[metric] },
    { label: "Requests", color: "#4caf50", value: totals?.requests },
  ];
  const percentage = (value?: number) =>
    value !== undefined && denominator !== undefined && denominator > 0 ? (value / denominator) * 100 : undefined;
  const usagePercent = percentage(sample?.[metric]);
  const unused =
    sample?.completeUsage && denominator !== undefined ? format(denominator - sample[metric]) : "Unavailable";
  const unrequested =
    denominator !== undefined && totals?.requests !== undefined ? format(denominator - totals.requests) : "Unavailable";
  const allocationDetail = `Allocatable: ${available(denominator)}. Schedulable capacity after system reservations, used as the denominator for both rings. Physical Capacity: ${available(totals?.capacity)}. Unused allocatable (usage): ${unused}. Unrequested: ${unrequested}`;
  const hovered = activeRing === undefined ? undefined : rings[activeRing];
  const tooltipId = `power-monitoring-${metric}-donut-tooltip`;
  return (
    <section
      aria-label={`${label} resource summary`}
      style={{
        padding: "var(--power-monitoring-summary-top, 16px) 16px 16px",
        minWidth: 0,
        background: "var(--contentColor)",
        position: "relative",
        overflow: "visible",
      }}
    >
      <ResourceTitle metric={metric} label={metric === "memory" ? "RAM" : "CPU"} />
      <svg
        data-monitoring-donut=""
        viewBox="0 0 200 200"
        role="img"
        aria-label={`${label} usage and requests relative to allocatable capacity`}
        style={{ display: "block", width: "100%", height: 200 }}
      >
        {rings.map((ring, index) => {
          const radius = 76 - index * 18;
          const percent = percentage(ring.value);
          const detail = `${ring.label}: ${available(ring.value)}${percent === undefined ? "" : ` (${percent.toFixed(1)}% of allocatable${percent > 100 ? ", over allocatable" : ""})`}`;
          return (
            <g
              key={ring.label}
              tabIndex={0}
              role="img"
              aria-label={detail}
              aria-describedby={activeRing === index ? tooltipId : undefined}
              onMouseEnter={() => setActiveRing(index)}
              onMouseMove={() => setActiveRing(index)}
              onMouseLeave={() => setActiveRing(undefined)}
              onFocus={() => setActiveRing(index)}
              onBlur={() => setActiveRing(undefined)}
            >
              <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--borderFaintColor)" strokeWidth="12" />
              {percent !== undefined && (
                <circle
                  data-monitoring-ring={ring.label}
                  cx="100"
                  cy="100"
                  r={radius}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth="12"
                  pathLength="100"
                  strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`}
                  transform="rotate(-90 100 100)"
                />
              )}
            </g>
          );
        })}
        <text
          data-monitoring-usage-percentage=""
          x="100"
          y="100"
          textAnchor="middle"
          fill="var(--textColorPrimary)"
          fontSize="26"
          fontWeight="600"
        >
          {usagePercent === undefined ? "N/A" : `${usagePercent.toFixed(1)}%`}
        </text>
        <text x="100" y="120" textAnchor="middle" fill="var(--textColorPrimary)" fontSize="12">
          Usage
        </text>
      </svg>
      {hovered && (
        <div
          id={tooltipId}
          data-monitoring-tooltip=""
          role="tooltip"
          style={{
            position: "absolute",
            top: 48,
            left: 8,
            right: 8,
            zIndex: 20,
            padding: 8,
            border: "1px solid var(--borderFaintColor)",
            background: "var(--contentColor)",
            pointerEvents: "none",
            overflowWrap: "anywhere",
            boxShadow: "0 3px 12px #0003",
          }}
        >
          <div style={{ color: hovered.color }}>
            {hovered.label}: {available(hovered.value)}
          </div>
          <div>
            {percentage(hovered.value) === undefined
              ? "Percentage unavailable"
              : `${percentage(hovered.value)!.toFixed(1)}% of allocatable${percentage(hovered.value)! > 100 ? " (over allocatable)" : ""}`}
          </div>
          <div>Allocatable: {available(denominator)}</div>
        </div>
      )}
      <div aria-label={`${label} resource totals`} style={{ display: "grid", gap: 6, fontSize: 12 }}>
        {rings.map((ring) => (
          <div
            key={ring.label}
            title={`${ring.label} relative to allocatable capacity. ${ring.label === "Usage" ? `Unused allocatable (usage): ${unused}` : `Unrequested: ${unrequested}`}`}
          >
            <span style={{ color: ring.color }}>●</span> {ring.label}: {available(ring.value)}
            {percentage(ring.value) !== undefined && <span> ({percentage(ring.value)!.toFixed(1)}%)</span>}
          </div>
        ))}
        <div title={allocationDetail}>
          <span style={{ color: "#5486b5" }}>●</span> Allocatable: {available(denominator)}
        </div>
      </div>
      {(status || sample?.resourceStatus) && (
        <div role="status" style={{ color: "var(--textColorSecondary)", fontSize: 11, marginTop: 8 }}>
          {status || sample?.resourceStatus}
        </div>
      )}
    </section>
  );
}

function MonitoringCharts({ samples, status }: { samples: MonitoringSample[]; status: string }) {
  return (
    <div style={{ containerType: "inline-size" }}>
      <style>{`
      [data-monitoring-layout] { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr); gap:16px; align-items:stretch }
      [data-monitoring-trends], [data-monitoring-summaries] { display:contents }
      @container (min-width: 961px) {
        [data-monitoring-summaries] > section { --power-monitoring-summary-top:16px }
      }
      @container (max-width: 960px) {
        [data-monitoring-layout] { grid-template-columns:repeat(2,minmax(0,1fr)) }
        .power-ai-overview-actions + [data-testid="cluster-overview-page"] [data-monitoring-trends] > section { --power-monitoring-trend-top:56px }
      }
      @container (max-width: 580px) {
        [data-monitoring-layout] { grid-template-columns:minmax(0,1fr) }
        .power-ai-overview-actions + [data-testid="cluster-overview-page"] [data-monitoring-trends] > section:not(:first-child) { --power-monitoring-trend-top:16px }
      }
    `}</style>
      <div data-monitoring-layout="">
        <div data-monitoring-trends="">
          {(["cpu", "memory"] as const).map((metric) => (
            <MetricChart key={metric} metric={metric} samples={samples} status={status} />
          ))}
        </div>
        <div data-monitoring-summaries="">
          {(["cpu", "memory"] as const).map((metric) => (
            <ResourceDonut key={metric} metric={metric} sample={samples.at(-1)} status={status} />
          ))}
        </div>
      </div>
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
  const suppression = document.createElement("style");
  suppression.setAttribute("data-freelens-power-native-metrics-suppression", "");
  suppression.textContent = `
    [data-testid="cluster-overview-page"] > [class*="ClusterMetrics"],
    [data-testid="cluster-overview-page"] > :has([class*="ClusterMetrics"]),
    [data-testid="cluster-overview-page"] > :is([class*="noMetrics"], [data-testid="no-metrics-message"]):not(:has(.PieChart)),
    [data-testid="cluster-overview-page"] > :has([class*="noMetrics"], [data-testid="no-metrics-message"], [class*="cluster-pie-charts"][class*="empty"]):not(:has(.PieChart)) {
      display:none !important;
    }
  `;
  document.head.append(suppression);
  let host: HTMLElement | undefined;
  let overview: Element | null = null;
  let samples: MonitoringSample[] = [];
  let status = "";
  let renderedSamples: MonitoringSample[] | undefined;
  let renderedStatus: string | undefined;
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
      renderedSamples = undefined;
      renderedStatus = undefined;
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
    const cutoff = Date.now() - MAX_SAMPLES * INTERVAL;
    if (samples.length && samples[0].time < cutoff) samples = samples.filter((sample) => sample.time >= cutoff);
    if (!overview || !cluster || document.visibilityState === "hidden") return;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-freelens-power-monitoring", "");
      host.style.gridColumn = "1 / -1";
      hidden.set(overview as HTMLElement, overview.getAttribute("style"));
      Object.assign((overview as HTMLElement).style, {
        gridTemplateAreas: "none",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "none",
        height: "auto",
      });
      overview.prepend(host);
    }
    for (const title of overview.querySelectorAll<HTMLElement>(".PieChart > .chart-title")) {
      if (title.textContent !== "CPU" && title.textContent !== "Memory") continue;
      const panel = title.closest(".PieChart")?.parentElement;
      if (panel && panel.style.display !== "none") {
        if (!hidden.has(panel)) hidden.set(panel, panel.getAttribute("style"));
        panel.style.display = "none";
      }
    }
    // native CSS modules retain [ClusterMetrics] in the generated class name
    for (const child of overview.children) {
      if (!(child instanceof HTMLElement) || child === host) continue;
      const nativeMetrics =
        child.matches('[class*="ClusterMetrics"]') || child.querySelector('[class*="ClusterMetrics"]');
      const unavailablePies =
        (child.matches('[class*="noMetrics"], [data-testid="no-metrics-message"]') ||
          child.querySelector(
            '[class*="noMetrics"], [data-testid="no-metrics-message"], [class*="cluster-pie-charts"][class*="empty"]',
          )) &&
        !child.querySelector(".PieChart");
      if ((nativeMetrics || unavailablePies) && child.style.display !== "none") {
        if (!hidden.has(child)) hidden.set(child, child.getAttribute("style"));
        child.style.display = "none";
      }
      if (!hidden.has(child)) hidden.set(child, child.getAttribute("style"));
      child.style.gridArea = "auto";
    }
    const render = () => {
      if (host && (renderedSamples !== samples || renderedStatus !== status)) {
        ReactDOM.render(<MonitoringCharts samples={samples} status={status} />, host);
        renderedSamples = samples;
        renderedStatus = status;
      }
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
      const [metrics, inventory, pods] = await Promise.allSettled([
        Renderer.K8sApi.nodesMetricsApi.list(),
        Promise.resolve().then(() => Renderer.K8sApi.nodesApi.list()),
        Promise.resolve().then(() => Renderer.K8sApi.podsApi.list()),
      ]);
      if (!isCurrent()) return;
      if (metrics.status !== "fulfilled") throw new Error("Metrics unavailable");
      const sample = aggregateMetrics(metrics.value ?? []);
      const warnings: string[] = [];
      if (inventory.status === "fulfilled") {
        try {
          sample.resources = aggregateResources(
            inventory.value ?? [],
            pods.status === "fulfilled" ? (pods.value ?? undefined) : undefined,
          );
          const expected = new Set((inventory.value ?? []).map((node) => node.metadata.name));
          const observed = new Set((metrics.value ?? []).map((node) => node.metadata.name));
          sample.completeUsage =
            expected.size > 0 && expected.size === observed.size && [...expected].every((name) => observed.has(name));
          if (!sample.completeUsage)
            warnings.push(
              "Partial node metrics coverage: usage is the reported subset; unused allocatable unavailable",
            );
        } catch {
          warnings.push("Resource totals unavailable: incomplete or invalid node/pod data");
        }
      } else
        warnings.push("Node inventory unavailable or access denied; usage coverage unverified, capacity unavailable");
      if (pods.status !== "fulfilled")
        warnings.push("Cluster-wide Pods unavailable or access denied; requests unavailable");
      sample.resourceStatus = warnings.join(". ");
      samples = [...samples, sample].slice(-MAX_SAMPLES);
      status = "";
    } catch {
      if (!isCurrent()) return;
      status = "Node metrics unavailable, stale or access denied. Last collected samples remain visible.";
    } finally {
      if (pendingGeneration === requestGeneration) pendingGeneration = undefined;
    }
    if (!stopped && requestGeneration === generation) render();
  };
  const observer = new MutationObserver(() => {
    void update();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = window.setInterval(() => {
    void update();
  }, 1000);
  void update();
  return () => {
    stopped = true;
    generation++;
    window.clearInterval(timer);
    observer.disconnect();
    suppression.remove();
    restore();
    samples = [];
  };
}
