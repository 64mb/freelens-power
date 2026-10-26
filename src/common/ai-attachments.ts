import { isKubernetesPayloadResource, redactKubernetesJsonText } from "./ai-resource-payload";
import { redactAiTerminalText } from "./ai-terminal-context";

export interface AiAttachmentReceipt {
  kind: "resource" | "evidence" | "terminal";
  title: string;
  text: string;
  capturedAt?: string;
  source?: "logs" | "relationships" | "diagnostics";
}

export function boundedAiJson(value: unknown, maxLength = 8000): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 8000;
  let limited = false;
  let remainingCharacters = 0;
  let remainingNodes = 0;
  const available = () => remainingCharacters > 0 && remainingNodes > 0;
  const project = (item: unknown, budget: number, depth: number, resourceHint = false): unknown => {
    remainingNodes--;
    if (depth > 8 || !available()) {
      limited = true;
      return null;
    }
    if (typeof item === "string") {
      const redacted = redactAiTerminalText(item);
      const count = Math.min(budget, remainingCharacters);
      if (redacted.length > count) limited = true;
      const result = redacted.slice(0, count);
      remainingCharacters -= result.length;
      return result;
    }
    if (Array.isArray(item)) {
      const count = Math.max(1, Math.min(100, Math.floor(budget / 20)));
      const result: unknown[] = [];
      for (let index = 0; index < item.length && index < count && available(); index++) {
        result.push(project(item[index], budget, depth + 1, resourceHint));
      }
      if (item.length > result.length) limited = true;
      return result;
    }
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (count >= 100 || !available()) {
          limited = true;
          break;
        }
        const safeKey = key.slice(0, Math.min(200, remainingCharacters));
        if (safeKey.length < key.length) limited = true;
        remainingCharacters -= safeKey.length;
        const child = (item as Record<string, unknown>)[key];
        const payload =
          (resourceHint || isKubernetesPayloadResource(item)) && ["data", "stringData", "binaryData"].includes(key);
        result[safeKey] = project(
          payload
            ? child && typeof child === "object" && !Array.isArray(child)
              ? Object.fromEntries(Object.keys(child).map((name) => [name, "[REDACTED]"]))
              : "[REDACTED]"
            : key === "kubectl.kubernetes.io/last-applied-configuration" && typeof child === "string"
              ? (() => {
                  try {
                    return redactKubernetesJsonText(child);
                  } catch {
                    return "[REDACTED]";
                  }
                })()
              : child,
          budget,
          depth + 1,
          ["SecretList", "ConfigMapList"].includes((item as Record<string, unknown>).kind as string) && key === "items",
        );
        count++;
      }
      return result;
    }
    remainingCharacters -= String(item).length;
    return item;
  };
  const serialize = (budget: number) => {
    limited = false;
    remainingCharacters = Math.max(1, limit * 2);
    remainingNodes = Math.max(1, Math.min(1000, Math.floor(limit / 8)));
    const projected = project(value, budget, 0);
    const marked = limited
      ? projected && typeof projected === "object" && !Array.isArray(projected)
        ? { ...projected, attachmentLimited: true }
        : { attachmentLimited: true, evidence: projected }
      : projected;
    return JSON.stringify(marked, null, 2) ?? "null";
  };
  let budget = Math.min(2000, limit);
  let result = serialize(budget);
  while (result.length > limit && budget > 0) {
    budget = Math.floor(budget / 2);
    result = serialize(budget);
  }
  if (result.length <= limit) return result;
  const fallback = '{"attachmentLimited":true}';
  return fallback.length <= limit ? fallback : limit >= 2 ? "{}" : limit === 1 ? "0" : "";
}

export function formatAiAttachmentText(text: string, maxLength = 64000, redact = false): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 64000;
  try {
    JSON.parse(text);
    const safe =
      (redact ? redactKubernetesJsonText(text) : text).match(
        /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g,
      ) ?? [];
    const compact = safe.join("");
    let depth = 0;
    let formatted = "";
    for (let index = 0; index < safe.length; index++) {
      const token = safe[index];
      if (token === "{" || token === "[") {
        if (++depth > 32) {
          formatted = compact;
          break;
        }
        formatted += token + (safe[index + 1] === "}" || safe[index + 1] === "]" ? "" : `\n${"  ".repeat(depth)}`);
      } else if (token === "}" || token === "]") {
        depth--;
        formatted += (safe[index - 1] === "{" || safe[index - 1] === "[" ? "" : `\n${"  ".repeat(depth)}`) + token;
      } else if (token === ",") formatted += `,\n${"  ".repeat(depth)}`;
      else formatted += token === ":" ? ": " : token;
    }
    if (formatted.length <= limit) return formatted;
    if (compact.length <= limit) return compact;
    let excerpt = compact.slice(0, Math.max(0, limit - 80));
    let wrapper = JSON.stringify({ attachmentLimited: true, excerpt }, null, 2);
    while (wrapper.length > limit && excerpt.length) {
      excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
      wrapper = JSON.stringify({ attachmentLimited: true, excerpt }, null, 2);
    }
    return wrapper.length <= limit ? wrapper : limit >= 2 ? "{}" : limit === 1 ? "0" : "";
  } catch {
    return (redact ? redactAiTerminalText(text) : text).slice(0, limit);
  }
}

export function normalizeAiAttachmentReceipts(value: unknown): AiAttachmentReceipt[] {
  if (!Array.isArray(value)) return [];
  const receipts: AiAttachmentReceipt[] = [];
  let remaining = 48000;
  for (const candidate of value.slice(0, 3)) {
    if (!candidate || typeof candidate !== "object" || Object.getPrototypeOf(candidate) !== Object.prototype) continue;
    const { kind, title, text, capturedAt, source } = candidate;
    if (
      !["resource", "evidence", "terminal"].includes(kind) ||
      typeof title !== "string" ||
      !title.trim() ||
      typeof text !== "string" ||
      !text.trim()
    )
      continue;
    const safeTitle = redactAiTerminalText(title).slice(0, 160);
    const limit = Math.min(
      kind === "terminal" ? 32768 : kind === "resource" ? 2000 : 8000,
      remaining - safeTitle.length - 100,
    );
    if (limit < 64) continue;
    const redacted = text;
    const marker = "\n[Attachment receipt truncated]";
    const safeText =
      redacted.length <= limit ? redacted : redacted.slice(0, Math.max(0, limit - marker.length)) + marker;
    const receipt: AiAttachmentReceipt = {
      kind,
      title: safeTitle,
      text: safeText,
      ...(typeof capturedAt === "string" && capturedAt.length <= 64 ? { capturedAt } : {}),
      ...(source === "logs" || source === "relationships" || source === "diagnostics" ? { source } : {}),
    };
    remaining -= safeTitle.length + safeText.length + (receipt.capturedAt?.length ?? 0) + (receipt.source?.length ?? 0);
    receipts.push(receipt);
  }
  return receipts;
}
