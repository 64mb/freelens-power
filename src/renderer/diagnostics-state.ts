export interface DiagnosticsResourceScope {
  kind: string;
  name: string;
  uid?: string;
}

export interface DiagnosticsViewState {
  tab: "Consumers" | "Timeline" | "Pending" | "Not ready";
  filter: string;
  namespaceScope?: string;
  resourceScope?: DiagnosticsResourceScope;
  needsAttention: boolean;
  groupMode: string;
  namespacesOpen: string[];
  sort: string;
  expanded: string[];
  selected: string;
  pendingUid: string;
  notReadyUid?: string;
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
export function focusDiagnosticsNamespace(
  clusterId: string,
  namespace?: string,
  resourceScope?: DiagnosticsResourceScope,
): void {
  if (!clusterId || (!namespace && !resourceScope)) return;
  saveDiagnosticsState(clusterId, {
    ...readDiagnosticsState(clusterId),
    tab: "Consumers",
    namespaceScope: namespace,
    resourceScope,
    filter: "",
    needsAttention: false,
    groupMode: namespace ? "namespace" : "workload",
    namespacesOpen: namespace ? [namespace] : [],
    scrollTop: 0,
  });
  window.dispatchEvent(
    new CustomEvent(DIAGNOSTICS_NAMESPACE_EVENT, { detail: { clusterId, namespace, resourceScope } }),
  );
}
