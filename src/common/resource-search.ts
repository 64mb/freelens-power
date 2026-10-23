export const RESOURCE_SEARCH_CHANNEL = "freelens-power:resource-search";
export interface SearchDocument {
  kind: string;
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  path: string;
  group: string;
  version: string;
  resource: string;
  uid?: string;
  aliases?: string[];
  fields?: { label: string; text: string }[];
}
export interface SearchQueryResult {
  documents: SearchDocument[];
  total: number;
  hasMore: boolean;
}
export interface SearchIndexStatus {
  count: number;
  bytes: number;
  available: boolean;
}
export type SearchIndexRequest = { clusterId: string; contextId: string } & (
  | { operation: "begin"; scope: string; scanId: string }
  | { operation: "complete"; scope: string; scanId: string }
  | { operation: "append"; scope: string; scanId: string; documents: SearchDocument[] }
  | { operation: "invalidate"; scope: string }
  | { operation: "reconcile"; resources: string[] }
  | { operation: "permit" }
  | { operation: "query"; query: string; limit?: number; kind?: string; namespace?: string }
  | { operation: "status" }
  | { operation: "clear" }
);

const identifier = (value: unknown, maximum = 253): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && /^[a-zA-Z0-9_.:-]+$/.test(value);
const objectName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  value !== "." &&
  value !== ".." &&
  !/[/%\x00-\x1f\x7f]/.test(value);

export function validSearchPartition(value: unknown): value is { clusterId: string; contextId: string } {
  const request = value as SearchIndexRequest;
  return !!request && identifier(request.clusterId, 128) && identifier(request.contextId, 256);
}

export function projectSearchDocuments(input: unknown): SearchDocument[] {
  if (!Array.isArray(input) || input.length > 500) throw new Error("Invalid search batch");
  return input.map((document: SearchDocument) => {
    if (
      !document ||
      !identifier(document.kind) ||
      !objectName(document.name) ||
      !identifier(document.version) ||
      !identifier(document.resource) ||
      !(document.group === "" || identifier(document.group)) ||
      !(document.namespace === undefined || identifier(document.namespace)) ||
      !(document.uid === undefined || identifier(document.uid, 128))
    )
      throw new Error("Invalid search identity");
    const path = `${document.group ? `/apis/${encodeURIComponent(document.group)}` : "/api"}/${encodeURIComponent(document.version)}/${document.namespace ? `namespaces/${encodeURIComponent(document.namespace)}/` : ""}${encodeURIComponent(document.resource)}/${encodeURIComponent(document.name)}`;
    if (document.path !== path) throw new Error("Invalid search path");
    const labels = Object.fromEntries(
      Object.entries(document.labels ?? {})
        .slice(0, 64)
        .filter(([key, value]) => key.length <= 253 && typeof value === "string" && value.length <= 256),
    );
    const reviewedCollections = new Set([
      "/pods",
      "/nodes",
      "/services",
      "/namespaces",
      "apps/deployments",
      "apps/statefulsets",
      "apps/daemonsets",
      "apps/replicasets",
      "batch/jobs",
      "batch/cronjobs",
      "networking.k8s.io/ingresses",
      "autoscaling/horizontalpodautoscalers",
    ]);
    const fields = reviewedCollections.has(`${document.group}/${document.resource}`)
      ? (document.fields ?? [])
          .slice(0, 32)
          .flatMap((field) =>
            field && typeof field.label === "string" && typeof field.text === "string"
              ? [{ label: field.label.slice(0, 64), text: field.text.slice(0, 512) }]
              : [],
          )
      : [];
    let remaining = 4096;
    return {
      kind: document.kind,
      name: document.name,
      namespace: document.namespace,
      labels,
      path,
      group: document.group,
      version: document.version,
      resource: document.resource,
      uid: document.uid,
      aliases: Array.isArray(document.aliases)
        ? document.aliases
            .filter((alias) => typeof alias === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(alias))
            .slice(0, 32)
        : [],
      fields: fields.flatMap((field) => {
        const text = field.text.slice(0, Math.max(0, remaining));
        remaining -= text.length;
        return text ? [{ label: field.label, text }] : [];
      }),
    };
  });
}
