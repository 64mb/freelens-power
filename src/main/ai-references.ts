import { type AiResourceReference, normalizeAiReferences } from "../common/ai-extras";

import type { AiReadQuery } from "./ai-resources";

// accept identities only after the resource projection has removed hidden environment values
export function collectAiReferences(summary: unknown, query: AiReadQuery): AiResourceReference[] {
  if (!summary || typeof summary !== "object") return [];
  const item = summary as Record<string, unknown>;
  if (Array.isArray(item.items))
    return normalizeAiReferences(item.items.slice(0, 200).flatMap((entry) => collectAiReferences(entry, query)));
  if (item.kind !== query.kind || item.apiVersion !== query.apiVersion || typeof item.name !== "string") return [];
  if (query.namespace && item.namespace !== query.namespace) return [];
  if (query.name && item.name !== query.name) return [];
  return normalizeAiReferences([
    { apiVersion: item.apiVersion, kind: item.kind, name: item.name, namespace: item.namespace },
  ]);
}
