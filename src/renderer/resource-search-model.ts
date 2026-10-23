import { boundedNameDistance } from "./resource-search-distance";

import type { SearchField } from "./resource-search-fields";
export interface SearchResource {
  kind: string;
  aliases?: string[];
  name: string;
  namespace?: string;
  labels: Record<string, string>;
  path: string;
  fields?: SearchField[];
}

export const RESOURCE_SEARCH_MAX_DOCUMENT_CHARS = 4096;
export const queryTokens = (query: string) =>
  query.slice(0, 300).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
const metadataText = (resource: SearchResource) =>
  [
    resource.kind,
    ...(resource.aliases ?? []),
    resource.name,
    resource.namespace ?? "",
    ...Object.entries(resource.labels).map(([key, value]) => `${key}=${value}`),
  ].join(" ");
function rankResources(resources: SearchResource[], tokens: string[]) {
  const score = (resource: SearchResource) =>
    tokens.reduce((total, token) => {
      const name = resource.name.toLocaleLowerCase();
      const kind = resource.kind.toLocaleLowerCase();
      const namespace = (resource.namespace ?? "").toLocaleLowerCase();
      return (
        total +
        (name === token
          ? 0
          : name.startsWith(token)
            ? 1
            : kind === token
              ? 2
              : name.includes(token)
                ? 3
                : kind.includes(token)
                  ? 4
                  : namespace.includes(token)
                    ? 5
                    : 6)
      );
    }, 0);

  return resources.sort((a, b) => score(a) - score(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function createResourceSearchIndex(resources: SearchResource[]) {
  const documents = resources;
  const vocabulary = new Map<string, Set<number>>();
  const names = new Map<number, Map<string, Set<number>>>();
  let lastQuery: string | undefined;
  let lastResults: SearchResource[] = [];
  let similarPaths = new Set<string>();
  let partsPaths = new Set<string>();
  const nameParts = new Map<number, string[]>();
  const partVocabulary = new Map<string, Set<number>>();
  const snippets = new Map<string, SearchField[]>();
  const metadata = new Map<string, string>();
  documents.forEach((resource, id) => {
    const parts = resource.name.toLocaleLowerCase().split(/[-._]/).filter(Boolean).slice(0, 16);
    nameParts.set(id, parts);
    for (const part of parts) {
      let ids = partVocabulary.get(part);
      if (!ids) {
        ids = new Set();
        partVocabulary.set(part, ids);
      }
      ids.add(id);
    }
    for (const name of new Set(
      [resource.name, ...resource.name.split(/[-.]/)].map((name) => name.toLocaleLowerCase()),
    )) {
      if (name.length < 3 || name.length > 64) continue;
      let bucket = names.get(name.length);
      if (!bucket) {
        bucket = new Map();
        names.set(name.length, bucket);
      }
      let ids = bucket.get(name);
      if (!ids) {
        ids = new Set();
        bucket.set(name, ids);
      }
      ids.add(id);
    }
    const identity = metadataText(resource).slice(0, RESOURCE_SEARCH_MAX_DOCUMENT_CHARS);
    metadata.set(resource.path, identity.toLocaleLowerCase());
    let remaining = RESOURCE_SEARCH_MAX_DOCUMENT_CHARS - identity.length;
    const fields: SearchField[] = [];
    for (const field of resource.fields ?? []) {
      if (remaining <= 1) break;
      const text = field.text.slice(0, remaining - 1);
      fields.push({ label: field.label, text });
      remaining -= text.length + 1;
    }
    snippets.set(resource.path, fields);
    for (const word of new Set(
      [identity, ...fields.map((field) => field.text)].join(" ").toLocaleLowerCase().split(/\s+/),
    )) {
      if (!word) continue;
      let ids = vocabulary.get(word);
      if (!ids) {
        ids = new Set();
        vocabulary.set(word, ids);
      }
      ids.add(id);
    }
  });
  return {
    search(query: string): SearchResource[] {
      query = query.slice(0, 300);
      if (lastQuery === query) return lastResults;
      lastQuery = query;
      similarPaths = new Set();
      partsPaths = new Set();
      lastResults = [];
      const tokens = queryTokens(query);
      const penalties = new Map<number, number>();
      let candidates: Set<number> | undefined;
      for (const token of tokens) {
        const found = new Set<number>();
        for (const [word, ids] of vocabulary) if (word.includes(token)) for (const id of ids) found.add(id);
        if (/^[a-z0-9]+(?:[-._][a-z0-9]+)+$/.test(token)) {
          const parts = token.split(/[-._]/);
          if (parts.length <= 16) {
            let possible: Set<number> | undefined;
            for (const part of parts) {
              const ids = partVocabulary.get(part) ?? new Set<number>();
              possible = possible === undefined ? ids : new Set([...possible].filter((id) => ids.has(id)));
            }
            for (const id of possible ?? []) {
              if (found.has(id)) continue;
              let offset = 0;
              for (const part of nameParts.get(id) ?? []) if (part === parts[offset]) offset++;
              if (offset === parts.length) {
                found.add(id);
                penalties.set(id, (penalties.get(id) ?? 0) + 1);
                partsPaths.add(documents[id].path);
              }
            }
          }
        }
        const exact = new Set(found);
        const limit = token.length >= 7 && token.length <= 64 ? 2 : token.length >= 4 && token.length <= 6 ? 1 : 0;
        if (limit) {
          const distances = new Map<number, number>();
          for (let length = token.length - limit; length <= token.length + limit; length++) {
            for (const [name, ids] of names.get(length) ?? []) {
              const distance = boundedNameDistance(token, name, limit);
              if (distance > limit) continue;
              for (const id of ids)
                if (!exact.has(id)) distances.set(id, Math.min(distances.get(id) ?? Infinity, distance));
            }
          }
          for (const [id, distance] of distances) {
            found.add(id);
            penalties.set(id, (penalties.get(id) ?? 0) + 10 * distance);
            similarPaths.add(documents[id].path);
          }
        }
        candidates = candidates === undefined ? found : new Set([...candidates].filter((id) => found.has(id)));
        if (!candidates.size) return [];
      }
      lastResults = rankResources(
        candidates === undefined ? [...documents] : [...candidates].map((id) => documents[id]),
        tokens,
      );
      const penaltyByPath = new Map([...penalties].map(([id, penalty]) => [documents[id].path, penalty]));
      lastResults.sort((left, right) => (penaltyByPath.get(left.path) ?? 0) - (penaltyByPath.get(right.path) ?? 0));
      return lastResults;
    },
    nameParts(resource: SearchResource): boolean {
      return partsPaths.has(resource.path);
    },
    similarName(resource: SearchResource): boolean {
      return similarPaths.has(resource.path);
    },
    snippet(resource: SearchResource, query: string): SearchField | undefined {
      const tokens = queryTokens(query);
      const identity = metadata.get(resource.path) ?? "";
      const bodyTokens = tokens.filter((token) => !identity.includes(token));
      if (!bodyTokens.length) return;
      const field = snippets
        .get(resource.path)
        ?.find((item) => bodyTokens.some((token) => item.text.toLocaleLowerCase().includes(token)));
      if (!field) return;
      const offset = Math.max(
        0,
        Math.min(
          ...bodyTokens.map((token) => field.text.toLocaleLowerCase().indexOf(token)).filter((index) => index >= 0),
        ) - 35,
      );
      return {
        label: field.label,
        text:
          (offset ? "…" : "") + field.text.slice(offset, offset + 150) + (field.text.length > offset + 150 ? "…" : ""),
      };
    },
  };
}

export function matchResources(resources: SearchResource[], query: string): SearchResource[] {
  return createResourceSearchIndex(resources).search(query);
}

export function createDoubleShift() {
  let last = 0;
  let held = false;
  const otherKeys = new Set<string>();
  return (
    event: Pick<KeyboardEvent, "key" | "type" | "repeat" | "altKey" | "ctrlKey" | "metaKey"> &
      Partial<Pick<KeyboardEvent, "code">>,
    now: number,
  ) => {
    const physicalKey = event.code || event.key;
    if (event.type === "keyup") {
      if (event.key === "Shift") held = false;
      else otherKeys.delete(physicalKey);
      if (event.key === "Meta") {
        otherKeys.clear();
        held = false;
        last = 0;
      }
      return false;
    }
    if (event.key !== "Shift") otherKeys.add(physicalKey);
    if (event.key !== "Shift" || otherKeys.size > 0 || event.altKey || event.ctrlKey || event.metaKey) {
      last = 0;
      return false;
    }
    if (event.repeat || held) return false;
    held = true;
    const hit = last > 0 && now - last <= 400;
    last = hit ? 0 : now;
    return hit;
  };
}
