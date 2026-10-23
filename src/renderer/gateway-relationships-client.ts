import type { GatewayInventory, GatewayObject } from "../common/gateway-relationships";

interface GatewayTransport {
  get<T>(path: string, query?: Record<string, string | number>): Promise<T>;
}
interface GatewayScope {
  focusedNamespace?: string;
  knownNamespaces?: string[];
}
const group = "gateway.networking.k8s.io";
const kinds = new Set([
  "GatewayClass",
  "Gateway",
  "HTTPRoute",
  "GRPCRoute",
  "TCPRoute",
  "TLSRoute",
  "UDPRoute",
  "ReferenceGrant",
]);
export async function loadGatewayInventory(
  transport: GatewayTransport,
  signal: AbortSignal,
  scope: GatewayScope = {},
): Promise<GatewayInventory> {
  const inventory: GatewayInventory = { objects: [], gaps: [] };
  const status = (error: unknown) =>
    (error as { status?: number; code?: number })?.status ??
    (error as { statusCode?: number })?.statusCode ??
    (error as { code?: number })?.code;
  let discovery: { versions?: { version: string }[]; preferredVersion?: { version: string } };
  try {
    discovery = await transport.get(`/apis/${group}`);
  } catch (error) {
    if (!signal.aborted && status(error) !== 404)
      inventory.gaps.push("Gateway API discovery unavailable; upstream evidence is unknown");
    return inventory;
  }
  const resources = new Map<string, { version: string; name: string; kind: string; namespaced: boolean }>();
  const versions = [
    ...new Set(
      [discovery.preferredVersion?.version, ...(discovery.versions ?? []).map((item) => item.version)].filter(
        (version): version is string => !!version,
      ),
    ),
  ];
  for (const version of versions) {
    if (signal.aborted) return inventory;
    try {
      const found = await transport.get<{
        resources?: { name: string; kind: string; namespaced: boolean; verbs?: string[] }[];
      }>(`/apis/${group}/${version}`);
      for (const resource of found.resources ?? [])
        if (
          kinds.has(resource.kind) &&
          !resource.name.includes("/") &&
          resource.verbs?.includes("list") &&
          !resources.has(resource.kind)
        )
          resources.set(resource.kind, { ...resource, version });
    } catch {
      inventory.gaps.push(`Gateway API ${version} discovery unavailable; coverage may be partial`);
    }
  }
  if (!resources.size) return inventory;
  let namespacesComplete = false;
  try {
    const namespaces = await transport.get<{ items?: GatewayObject[]; metadata?: { continue?: string } }>(
      "/api/v1/namespaces",
      { limit: 100 },
    );
    inventory.namespaces = namespaces.items;
    namespacesComplete = !namespaces.metadata?.continue;
    if (!namespacesComplete)
      inventory.gaps.push("Namespace labels partially observed; Gateway namespace selectors may be unknown");
  } catch {
    inventory.gaps.push("Namespace labels unavailable; Gateway namespace selectors may be unknown");
  }
  const namespaces = [
    ...new Set(
      [
        scope.focusedNamespace,
        ...(scope.knownNamespaces ?? []),
        ...(inventory.namespaces ?? []).map((item) => item.metadata.name),
      ].filter((name): name is string => !!name),
    ),
  ];
  for (const resource of resources.values()) {
    if (signal.aborted) return inventory;
    const items: GatewayObject[] = [];
    let remaining = 20;
    const base = `/apis/${group}/${resource.version}`;
    const scan = async (namespace?: string) => {
      let continuation = "";
      do {
        if (signal.aborted || remaining-- <= 0) return false;
        const list = await transport.get<{ items?: GatewayObject[]; metadata?: { continue?: string } }>(
          `${base}/${namespace ? `namespaces/${encodeURIComponent(namespace)}/` : ""}${resource.name}`,
          { limit: 100, ...(continuation ? { continue: continuation } : {}) },
        );
        for (const item of list.items ?? [])
          items.push({
            ...item,
            kind: resource.kind,
            apiVersion: `${group}/${resource.version}`,
            selfLink: `${base}/${resource.namespaced ? `namespaces/${encodeURIComponent(item.metadata.namespace ?? namespace ?? "")}/` : ""}${resource.name}/${encodeURIComponent(item.metadata.name ?? "")}`,
          });
        continuation = list.metadata?.continue ?? "";
      } while (continuation);
      return true;
    };
    let complete = false;
    try {
      complete = await scan();
    } catch (error) {
      if (status(error) === 403 && resource.namespaced) {
        const completedNamespaces: string[] = [];
        for (const namespace of namespaces) {
          if (signal.aborted || remaining <= 0) break;
          try {
            if (await scan(namespace)) completedNamespaces.push(namespace);
          } catch {
            inventory.gaps.push(`${resource.kind} unavailable in namespace ${namespace}; evidence is unknown`);
          }
        }
        complete = namespacesComplete && completedNamespaces.length === namespaces.length;
        if (resource.kind === "ReferenceGrant") inventory.grantNamespaces = completedNamespaces;
        if (!complete)
          inventory.gaps.push(
            `${resource.kind} namespace fallback is partial; unlisted or denied namespaces remain unknown`,
          );
      } else if (!signal.aborted)
        inventory.gaps.push(`${resource.kind} inventory unavailable; references and acceptance may be unknown`);
    }
    if (!complete && remaining <= 0)
      inventory.gaps.push(`${resource.kind} inventory partial; relationship request budget reached`);
    if (resource.kind === "ReferenceGrant") {
      if (complete || inventory.grantNamespaces?.length) inventory.grants = items;
    } else inventory.objects.push(...items);
  }
  return inventory;
}
