import type { SearchDocument } from "../common/resource-search";

export interface SearchCollection {
  group: string;
  version: string;
  resource: string;
  kind: string;
  namespaced: boolean;
  aliases: string[];
}
export interface SearchTransport {
  get<T>(path: string, query?: Record<string, string | number>, headers?: Record<string, string>): Promise<T>;
}
interface DiscoveryResource {
  name?: string;
  resource?: string;
  kind?: string;
  responseKind?: { kind?: string };
  namespaced?: boolean;
  scope?: string;
  verbs?: string[];
  shortNames?: string[];
  singularName?: string;
}
interface GroupDiscovery {
  metadata?: { name?: string };
  versions?: { version: string; freshness?: string; resources?: DiscoveryResource[] }[];
}
export const collectionPath = (type: SearchCollection, namespace?: string) =>
  `${type.group ? `/apis/${encodeURIComponent(type.group)}/${encodeURIComponent(type.version)}` : `/api/${encodeURIComponent(type.version)}`}${namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ""}/${encodeURIComponent(type.resource)}`;

function collection(resource: DiscoveryResource, group: string, version: string): SearchCollection[] {
  const name = resource.name ?? resource.resource;
  const kind = resource.kind ?? resource.responseKind?.kind;
  if (!name || !kind || name.includes("/") || !resource.verbs?.includes("list")) return [];
  return [
    {
      group,
      version,
      resource: name,
      kind,
      namespaced: resource.namespaced ?? resource.scope === "Namespaced",
      aliases: [...(resource.shortNames ?? []), ...(resource.singularName ? [resource.singularName] : [])],
    },
  ];
}
export async function discoverSearchCollections(
  transport: SearchTransport,
  unavailable: (scope: string) => void = () => {},
): Promise<SearchCollection[]> {
  const types = new Map<string, SearchCollection>();
  const add = (items: SearchCollection[]) => {
    for (const item of items)
      if (!types.has(`${item.group}/${item.resource}`)) types.set(`${item.group}/${item.resource}`, item);
  };
  for (const root of ["/api", "/apis"]) {
    let response: {
      items?: GroupDiscovery[];
      versions?: string[];
      groups?: { name: string; preferredVersion?: { version: string }; versions?: { version: string }[] }[];
    };
    try {
      response = await transport.get(root, undefined, {
        Accept: "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList, application/json",
      });
    } catch {
      unavailable(root);
      continue;
    }
    if (response.items) {
      for (const group of response.items)
        for (const version of group.versions ?? []) {
          if (version.freshness === "Stale") unavailable(`${group.metadata?.name ?? ""}/${version.version}`);
          add(
            (version.resources ?? []).flatMap((resource) =>
              collection(resource, group.metadata?.name ?? "", version.version),
            ),
          );
        }
      continue;
    }
    const groups =
      root === "/api"
        ? [{ name: "", versions: (response.versions ?? ["v1"]).map((version) => ({ version })) }]
        : (response.groups ?? []);
    for (const group of groups) {
      const versions = [
        ...("preferredVersion" in group && group.preferredVersion ? [group.preferredVersion] : []),
        ...(group.versions ?? []),
      ];
      for (const { version } of versions) {
        const path = group.name ? `/apis/${group.name}/${version}` : `/api/${version}`;
        try {
          const data = await transport.get<{ resources?: DiscoveryResource[] }>(path);
          add((data.resources ?? []).flatMap((resource) => collection(resource, group.name, version)));
        } catch {
          unavailable(path);
        }
      }
    }
  }
  return [...types.values()];
}
export interface MetadataPage {
  metadata?: { continue?: string; resourceVersion?: string };
  items?: { metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, unknown> } }[];
}
export function projectMetadataPage(type: SearchCollection, page: MetadataPage): SearchDocument[] {
  return (page.items ?? []).flatMap(({ metadata }) =>
    metadata?.name
      ? [
          {
            aliases: type.aliases,
            group: type.group,
            version: type.version,
            resource: type.resource,
            kind: type.kind,
            name: metadata.name,
            namespace: metadata.namespace,
            uid: metadata.uid,
            labels: Object.fromEntries(
              Object.entries(metadata.labels ?? {}).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
            path: `${collectionPath(type, metadata.namespace)}/${encodeURIComponent(metadata.name)}`,
          },
        ]
      : [],
  );
}
export const searchErrorStatus = (error: unknown): number => {
  if (!error || typeof error !== "object") return 0;
  const value = error as { status?: number; code?: number; response?: { status?: number } };
  return value.status ?? value.response?.status ?? value.code ?? 0;
};
