export interface HpaDiagnosticsInput {
  spec?: { minReplicas?: number; maxReplicas: number };
  status?: {
    currentReplicas?: number;
    desiredReplicas?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}
export function diagnoseHpa(hpa: HpaDiagnosticsInput) {
  const min = hpa.spec?.minReplicas ?? 1;
  const max = hpa.spec?.maxReplicas;
  const conditions = hpa.status?.conditions ?? [];
  const evidence = conditions.map(
    (c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`,
  );
  const disabled =
    hpa.status?.currentReplicas === 0 &&
    conditions.some((c) => c.type === "ScalingActive" && c.status === "False" && c.reason === "ScalingDisabled");
  const failed = conditions.some(
    (c) =>
      (c.type === "ScalingActive" || c.type === "AbleToScale") &&
      c.status === "False" &&
      !(disabled && c.type === "ScalingActive" && c.reason === "ScalingDisabled"),
  );
  const limited = conditions.find((c) => c.type === "ScalingLimited" && c.status === "True");
  const maxBlocked = limited?.reason === "TooManyReplicas" && min !== max;
  const state = failed || maxBlocked ? "warning" : "neutral";
  const summary = failed
    ? "Autoscaling reports a controller or metric failure"
    : disabled
      ? "Autoscaling is disabled while the target has zero replicas"
      : min === max
        ? "Replica count is fixed by equal minimum and maximum"
        : maxBlocked
          ? "Desired scale exceeds the configured maximum"
          : limited?.reason === "TooFewReplicas"
            ? "Minimum replicas constrain downscaling"
            : limited
              ? "Scaling is limited; inspect the controller reason"
              : conditions.length
                ? "No scaling blocker reported by available conditions"
                : "Autoscaling conditions are unavailable";
  return {
    state,
    summary,
    evidence,
    current: hpa.status?.currentReplicas,
    desired: hpa.status?.desiredReplicas,
    min,
    max,
  };
}
