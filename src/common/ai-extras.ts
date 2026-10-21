import type { AiChatRequest } from "./ai";

export const AI_CANCEL_CHANNEL = "freelens-power:ai-cancel";

export interface AiResourceReference {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

const identifier = /^[a-z0-9][a-z0-9.-]{0,252}$/;

export function validAiResourceReference(value: unknown): value is AiResourceReference {
  if (!value || typeof value !== "object") return false;
  const item = value as AiResourceReference;
  return (
    typeof item.apiVersion === "string" &&
    /^(?:[a-z0-9][a-z0-9.-]{0,200}\/)?v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/.test(item.apiVersion) &&
    typeof item.kind === "string" &&
    /^[A-Z][A-Za-z0-9]{0,100}$/.test(item.kind) &&
    typeof item.name === "string" &&
    identifier.test(item.name) &&
    (item.namespace === undefined || (typeof item.namespace === "string" && identifier.test(item.namespace)))
  );
}

export function normalizeAiReferences(value: unknown): AiResourceReference[] {
  if (!Array.isArray(value)) return [];
  const references: AiResourceReference[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 200)) {
    if (!validAiResourceReference(item)) continue;
    const reference: AiResourceReference = {
      apiVersion: item.apiVersion,
      kind: item.kind,
      name: item.name,
      ...(item.namespace ? { namespace: item.namespace } : {}),
    };
    const key = JSON.stringify(reference);
    if (!seen.has(key)) references.push(reference);
    seen.add(key);
  }
  return references;
}

export function referencedAiResources(text: string, value: unknown): AiResourceReference[] {
  const candidates = normalizeAiReferences(value);
  const tokens = new Set((text.match(/[A-Za-z0-9][A-Za-z0-9.-]*/g) ?? []).map((token) => token.replace(/\.+$/, "")));
  const qualifiedTokens = new Set(
    (text.match(/[A-Za-z0-9][A-Za-z0-9./-]*/g) ?? []).map((token) => token.replace(/\.+$/, "")),
  );
  return candidates
    .filter((reference) => {
      if (!tokens.has(reference.name)) return false;
      const matches = candidates.filter((item) => item.name === reference.name);
      if (matches.length === 1) {
        const qualifiedMentions = [...qualifiedTokens].filter((token) => token.endsWith(`/${reference.name}`));
        return (
          !qualifiedMentions.length ||
          qualifiedMentions.some(
            (token) =>
              token === `${reference.namespace}/${reference.name}` || token === `${reference.kind}/${reference.name}`,
          )
        );
      }
      // ambiguous names require an explicit namespace/name pair in the answer
      const qualified = reference.namespace ? `${reference.namespace}/${reference.name}` : "";
      if (!qualified || !qualifiedTokens.has(qualified)) return false;
      return matches.filter((item) => item.namespace === reference.namespace).length === 1;
    })
    .slice(0, 5);
}

export function attachedAiContext(context: AiChatRequest["context"]): AiChatRequest["context"] {
  const result: AiChatRequest["context"] = {};
  if (typeof context.clusterId === "string" && context.clusterId.length <= 256) result.clusterId = context.clusterId;
  if (typeof context.screen === "string" && context.screen.startsWith("/") && !/[?#]/.test(context.screen))
    result.screen = context.screen.slice(0, 2048);
  if (context.resource && typeof context.resource === "object") {
    const resource: NonNullable<AiChatRequest["context"]["resource"]> = {};
    for (const key of ["kind", "namespace", "name"] as const) {
      const value = context.resource[key];
      if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value)) resource[key] = value;
    }
    if (Object.keys(resource).length) result.resource = resource;
  }
  return result;
}
