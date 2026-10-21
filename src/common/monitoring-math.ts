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
  breakBefore?: boolean;
  historical?: Partial<
    Record<"cpu" | "memory", { min: number; max: number; count: number; resolution: number; gap: boolean }>
  >;
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
export const MONITORING_INTERVAL = 30_000;
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
