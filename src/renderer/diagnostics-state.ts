export interface DiagnosticsViewState {
  tab: "Consumers" | "Timeline" | "Pending";
  filter: string;
  namespaceScope?: string;
  needsAttention: boolean;
  groupMode: string;
  namespacesOpen: string[];
  sort: string;
  expanded: string[];
  selected: string;
  pendingUid: string;
  reason: string;
  warningOnly: boolean;
  groupedTimeline: boolean;
  openTimeline: string[];
  scrollTop: number;
}
// renderer memory stores view preferences only, never snapshots or resource contents
const states = new Map<string, DiagnosticsViewState>();
export function readDiagnosticsState(clusterId: string): DiagnosticsViewState {
  return (
    states.get(clusterId) ?? {
      tab: "Consumers",
      filter: "",
      needsAttention: true,
      groupMode: "workload",
      namespacesOpen: [],
      sort: "cpu",
      expanded: [],
      selected: "",
      pendingUid: "",
      reason: "",
      warningOnly: true,
      groupedTimeline: true,
      openTimeline: [],
      scrollTop: 0,
    }
  );
}
export function saveDiagnosticsState(clusterId: string, state: DiagnosticsViewState): void {
  if (!clusterId) return;
  states.delete(clusterId);
  states.set(clusterId, state);
  if (states.size > 30) states.delete(states.keys().next().value!);
}
export function clearDiagnosticsStates(): void {
  states.clear();
}

export const DIAGNOSTICS_NAMESPACE_EVENT = "power-diagnostics-namespace";
export function focusDiagnosticsNamespace(clusterId: string, namespace: string): void {
  if (!clusterId || !namespace) return;
  saveDiagnosticsState(clusterId, {
    ...readDiagnosticsState(clusterId),
    tab: "Consumers",
    namespaceScope: namespace,
    filter: "",
    needsAttention: false,
    groupMode: "namespace",
    namespacesOpen: [namespace],
    scrollTop: 0,
  });
  window.dispatchEvent(new CustomEvent(DIAGNOSTICS_NAMESPACE_EVENT, { detail: { clusterId, namespace } }));
}
