export interface ServiceDiagnosticObject {
  metadata: { name?: string; namespace?: string; labels?: Partial<Record<string, string>> };
  spec?: {
    type?: string;
    externalName?: string;
    selector?: Partial<Record<string, string>>;
    publishNotReadyAddresses?: boolean;
    ipFamilies?: string[];
    ports?: { name?: string; port: number; targetPort?: string | number; protocol?: string }[];
  };
}
export interface ServiceDiagnosticPod {
  metadata: { name?: string; namespace?: string; labels?: Partial<Record<string, string>>; deletionTimestamp?: string };
  spec?: {
    containers?: { ports?: { name?: string; containerPort: number; protocol?: string }[] }[];
    initContainers?: {
      restartPolicy?: string;
      ports?: { name?: string; containerPort: number; protocol?: string }[];
    }[];
  };
  status?: { conditions?: { type: string; status: string }[] };
}
export interface ServiceDiagnosticSlice {
  metadata: { name?: string; namespace?: string; labels?: Partial<Record<string, string>> };
  addressType: string;
  endpoints?: { addresses: string[]; conditions?: { ready?: boolean; terminating?: boolean } }[] | null;
  ports?: { name?: string; port?: number | null; protocol?: string }[] | null;
}
export function diagnoseService<P extends ServiceDiagnosticPod, S extends ServiceDiagnosticSlice>(
  service: ServiceDiagnosticObject,
  pods: P[] | undefined,
  slices: S[] | undefined,
) {
  const selector = Object.entries(service.spec?.selector ?? {});
  const external = service.spec?.type === "ExternalName";
  const matchingPods = selector.length
    ? pods?.filter(
        (p) =>
          p.metadata.namespace === service.metadata.namespace &&
          selector.every(([k, v]) => p.metadata.labels?.[k] === v),
      )
    : undefined;
  const readyPods = matchingPods?.filter(
    (p) =>
      !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
  );
  const matchingSlices = slices?.filter(
    (s) =>
      s.metadata.namespace === service.metadata.namespace &&
      s.metadata.labels?.["kubernetes.io/service-name"] === service.metadata.name,
  );
  const families = [...new Set(matchingSlices?.map((s) => s.addressType) ?? [])];
  const readyEndpoints = matchingSlices?.reduce(
    (sum, s) =>
      sum +
      (s.endpoints?.filter((e) => e.conditions?.ready !== false && !e.conditions?.terminating && e.addresses.length)
        .length ?? 0),
    0,
  );
  const limitations = ["API configuration and readiness evidence only; network reachability is not tested"];
  if (pods === undefined && selector.length) limitations.push("Pod data unavailable; access may be restricted");
  if (slices === undefined && !external) limitations.push("EndpointSlice data unavailable; access may be restricted");
  if (!selector.length && !external)
    limitations.push("Selectorless service: endpoints are managed separately; pod matching is not applicable");
  if (service.spec?.publishNotReadyAddresses)
    limitations.push("Service publishes not-ready addresses; endpoint readiness does not establish pod readiness");
  if (families.length > 1)
    limitations.push("Endpoint counts include separate address families and may count the same backend more than once");
  for (const family of service.spec?.ipFamilies ?? []) {
    if (matchingSlices && !families.includes(family))
      limitations.push(`No EndpointSlice evidence for configured address family ${family}`);
  }
  const ports = (service.spec?.ports ?? []).map((port) => {
    const target = port.targetPort ?? port.port;
    const protocol = port.protocol ?? "TCP";
    const unresolved =
      typeof target === "string"
        ? matchingPods?.filter(
            (p) =>
              ![
                ...(p.spec?.containers ?? []),
                ...(p.spec?.initContainers ?? []).filter((c) => c.restartPolicy === "Always"),
              ].some((c) => c.ports?.some((p) => p.name === target && (p.protocol ?? "TCP") === protocol)),
          ).length
        : undefined;
    const slicePorts = matchingSlices?.flatMap((s) =>
      (s.ports ?? [])
        .filter((p) => (p.name ?? "") === (port.name ?? "") && (p.protocol ?? "TCP") === protocol)
        .flatMap((p) => (p.port == null ? [] : [p.port])),
    );
    return {
      name: port.name ?? String(port.port),
      target,
      protocol,
      unresolved,
      endpointPorts: [...new Set(slicePorts ?? [])],
      missingEndpointPort: matchingSlices !== undefined && !slicePorts?.length,
      numericMismatch: typeof target === "number" && !!slicePorts?.some((value) => value !== target),
    };
  });
  const missingEndpointPorts = ports.some((port) => port.missingEndpointPort);
  if (missingEndpointPorts)
    limitations.push("Matching EndpointSlice port and protocol evidence is missing for one or more Service ports");
  const summary = external
    ? "ExternalName delegates service discovery to DNS"
    : !selector.length
      ? "Inspect manually managed EndpointSlices"
      : matchingPods === undefined || matchingSlices === undefined
        ? "Partial evidence; backend health cannot be established"
        : !matchingPods.length
          ? "Selector matches no pods"
          : !readyEndpoints
            ? "No ready EndpointSlice backends reported"
            : missingEndpointPorts
              ? "Partial evidence; matching EndpointSlice port and protocol are unavailable"
              : `${readyPods?.length ?? 0}/${matchingPods.length} selected pods ready; ${readyEndpoints} ready endpoint entries`;
  return {
    summary,
    external,
    missingEndpointPorts,
    matchingPods,
    readyPods,
    matchingSlices,
    readyEndpoints,
    families,
    ports,
    limitations,
  };
}
