import type { AiDiscoveredResource } from "./ai-resources";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
const group = /^[a-z0-9][a-z0-9.-]{0,200}$/;
const version = /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/;

export function sanitizeAiDiscovery(value: unknown, apiVersion: string): AiDiscoveredResource[] {
  const resources = object(value).resources;
  if (!Array.isArray(resources)) return [];
  return resources.slice(0, 300).flatMap((entry) => {
    const item = object(entry);
    if (
      typeof item.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,100}$/.test(item.name) ||
      typeof item.kind !== "string" ||
      !/^[A-Z][A-Za-z0-9]{0,100}$/.test(item.kind) ||
      typeof item.namespaced !== "boolean" ||
      !Array.isArray(item.verbs)
    )
      return [];
    const verbs = (["get", "list"] as const).filter((verb) => (item.verbs as unknown[]).includes(verb));
    return verbs.length
      ? [{ apiVersion, kind: item.kind, resource: item.name, namespaced: item.namespaced, verbs }]
      : [];
  });
}

// discovery requests are generated locally and cannot include model-supplied URLs or subresources
export async function discoverAiResources(
  get: (path: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<AiDiscoveredResource[]> {
  signal?.throwIfAborted();
  const [core, apiGroups] = await Promise.all([get("/api"), get("/apis")]);
  const paths = new Map<string, string>();
  const coreVersions = object(core).versions;
  if (Array.isArray(coreVersions))
    for (const item of coreVersions) {
      if (typeof item === "string" && version.test(item)) paths.set(`/api/${item}`, item);
    }
  const groups = object(apiGroups).groups;
  if (Array.isArray(groups))
    for (const value of groups.slice(0, 100)) {
      const item = object(value);
      if (typeof item.name !== "string" || !group.test(item.name)) continue;
      const versions = Array.isArray(item.versions) ? item.versions : [];
      for (const entry of versions.slice(0, 5)) {
        const name = object(entry).version;
        if (typeof name === "string" && version.test(name))
          paths.set(`/apis/${item.name}/${name}`, `${item.name}/${name}`);
      }
    }
  const result: AiDiscoveredResource[] = [];
  const bounded = [...paths.entries()].slice(0, 40);
  for (let index = 0; index < bounded.length; index += 4) {
    signal?.throwIfAborted();
    const batch = await Promise.all(
      bounded.slice(index, index + 4).map(async ([path, apiVersion]) => {
        try {
          return sanitizeAiDiscovery(await get(path), apiVersion);
        } catch {
          return [];
        }
      }),
    );
    result.push(...batch.flat());
  }
  signal?.throwIfAborted();
  return result.slice(0, 1000);
}
