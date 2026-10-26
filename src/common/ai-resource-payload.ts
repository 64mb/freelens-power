import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from "yaml";

const REDACTED = "[REDACTED]";
const annotation = "kubectl.kubernetes.io/last-applied-configuration";
const payloadFields = new Set(["data", "stringData", "binaryData"]);

export function isKubernetesPayloadResource(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    ["Secret", "ConfigMap"].includes((value as Record<string, unknown>).kind as string)
  );
}

export function redactKubernetesPayload(value: unknown, approvedKind?: string): unknown {
  const ancestors = new WeakSet<object>();
  let remaining = 10000;
  const visit = (item: unknown, depth: number, resourceHint = false, listHint = false): unknown => {
    if (--remaining < 0 || depth > 64) return REDACTED;
    if (typeof item === "string") {
      try {
        JSON.parse(item);
        return redactKubernetesJsonText(item);
      } catch {
        /* ordinary text remains intact */
      }
      return redactKubernetesYamlText(item);
    }
    if (!item || typeof item !== "object") return item;
    if (ancestors.has(item)) return REDACTED;
    ancestors.add(item);
    let result: unknown;
    if (Array.isArray(item))
      result = item.length > remaining ? REDACTED : item.map((child) => visit(child, depth + 1, resourceHint));
    else {
      const clone: Record<string, unknown> = Object.create(null);
      const resource = resourceHint || isKubernetesPayloadResource(item);
      const typedList =
        listHint ||
        ["SecretList", "ConfigMapList"].includes((item as Record<string, unknown>).kind as string) ||
        (resourceHint && Array.isArray((item as Record<string, unknown>).items));
      const keys = Object.keys(item);
      if (keys.length > remaining) {
        ancestors.delete(item);
        return REDACTED;
      }
      for (const key of keys) {
        if (remaining <= 0) {
          clone[key] = REDACTED;
          continue;
        }
        const child = (item as Record<string, unknown>)[key];
        if (resource && payloadFields.has(key))
          clone[key] =
            child && typeof child === "object" && !Array.isArray(child)
              ? Object.keys(child).length > remaining
                ? REDACTED
                : Object.fromEntries(Object.keys(child).map((name) => [name, REDACTED]))
              : REDACTED;
        else if (key === annotation && typeof child === "string") {
          try {
            clone[key] = redactKubernetesJsonText(child);
          } catch {
            clone[key] = REDACTED;
          }
        } else clone[key] = visit(child, depth + 1, typedList && key === "items");
      }
      result = clone;
    }
    ancestors.delete(item);
    return result;
  };
  return visit(
    value,
    0,
    ["Secret", "ConfigMap"].includes(approvedKind ?? ""),
    ["SecretList", "ConfigMapList"].includes(approvedKind ?? ""),
  );
}

// retain original scalar tokens so unrelated numeric values never pass through floating point conversion
export function redactKubernetesJsonText(text: string, encodedDepth = 0): string {
  if (encodedDepth > 8) return JSON.stringify(REDACTED);
  JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) ?? [];
  let position = 0;
  type Node = { start: number; end: number; fields?: [string, Node][]; children?: Node[] };
  let remainingNodes = 10000;
  const parse = (depth = 0): Node => {
    if (--remainingNodes < 0 || depth > 64) throw new RangeError("resource payload complexity limit");
    const start = position++;
    const node: Node = { start, end: position };
    if (tokens[start] === "{") {
      node.fields = [];
      while (tokens[position] !== "}") {
        const key = JSON.parse(tokens[position++]) as string;
        position++;
        node.fields.push([key, parse(depth + 1)]);
        if (tokens[position] !== ",") break;
        position++;
      }
      position++;
    } else if (tokens[start] === "[") {
      node.children = [];
      while (tokens[position] !== "]") {
        node.children.push(parse(depth + 1));
        if (tokens[position] !== ",") break;
        position++;
      }
      position++;
    }
    node.end = position;
    return node;
  };
  const replacements = new Map<number, { end: number; text: string }>();
  const replace = (node: Node, value: string) =>
    replacements.set(node.start, { end: node.end, text: JSON.stringify(value) });
  const visit = (node: Node, key?: string, resourceHint = false) => {
    const resource =
      resourceHint ||
      node.fields?.some(
        ([name, child]) =>
          name === "kind" &&
          tokens[child.start].startsWith('"') &&
          ["Secret", "ConfigMap"].includes(JSON.parse(tokens[child.start])),
      );
    const typedList = node.fields?.some(
      ([name, child]) =>
        name === "kind" &&
        tokens[child.start].startsWith('"') &&
        ["SecretList", "ConfigMapList"].includes(JSON.parse(tokens[child.start])),
    );
    for (const [name, child] of node.fields ?? []) {
      if (resource && payloadFields.has(name)) {
        if (child.fields) for (const [, value] of child.fields) replace(value, REDACTED);
        else replace(child, REDACTED);
      } else visit(child, name, !!typedList && name === "items");
    }
    for (const child of node.children ?? []) visit(child, undefined, resourceHint);
    if (tokens[node.start]?.startsWith('"')) {
      const value = JSON.parse(tokens[node.start]) as string;
      try {
        JSON.parse(value);
        const safe = redactKubernetesJsonText(value, encodedDepth + 1);
        if (safe !== value) replace(node, safe);
      } catch {
        if (key === annotation) replace(node, REDACTED);
        else {
          const safe = redactKubernetesYamlText(value, encodedDepth + 1);
          if (safe !== value) replace(node, safe);
        }
      }
    }
  };
  try {
    visit(parse());
  } catch {
    return JSON.stringify(REDACTED);
  }
  if (!replacements.size) return text;
  const result: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const replacement = replacements.get(index);
    result.push(replacement?.text ?? tokens[index]);
    index = replacement?.end ?? index + 1;
  }
  return result.join("");
}

export function redactKubernetesYamlText(text: string, encodedDepth = 0): string {
  if (encodedDepth > 8) return JSON.stringify(REDACTED);
  const edits: { start: number; end: number; text: string }[] = [];
  const recognizable = (source: string) =>
    /["']?kind["']?\s*:\s*["']?(Secret|ConfigMap)(?:List)?\b/.test(source) &&
    (/^\s*(?:-\s*)?["']?(data|stringData|binaryData)["']?\s*:/m.test(source) ||
      /^\s*[\[{].*["']?(data|stringData|binaryData)["']?\s*:/m.test(source));
  try {
    for (const doc of parseAllDocuments(text, { schema: "failsafe", resolveKnownTags: false, uniqueKeys: false })) {
      let remaining = 30000;
      let recognized = false;
      const source = text.slice(doc.range?.[0], doc.range?.[2]);
      const ancestors = new Set<unknown>();
      const anchors = new Map<string, { node: unknown; offset: number }[]>();
      const index = [{ node: doc.contents as unknown, depth: 0 }];
      try {
        while (index.length) {
          const current = index.pop()!;
          if (--remaining < 0 || current.depth > 64) throw new RangeError("resource payload complexity limit");
          const node = current.node;
          if (!isNode(node)) continue;
          const anchor = (node as { anchor?: string }).anchor;
          if (anchor && node.range) {
            const definitions = anchors.get(anchor) ?? [];
            definitions.push({ node, offset: node.range[0] });
            anchors.set(anchor, definitions);
          }
          if (isMap(node))
            for (const pair of node.items)
              index.push({ node: pair.key, depth: current.depth + 1 }, { node: pair.value, depth: current.depth + 1 });
          else if (isSeq(node)) for (const child of node.items) index.push({ node: child, depth: current.depth + 1 });
        }
        for (const definitions of anchors.values()) definitions.sort((a, b) => a.offset - b.offset);
        const resolved = (node: unknown): unknown => {
          if (!isAlias(node)) return node;
          const definitions = anchors.get(node.source);
          if (!definitions) return;
          let low = 0;
          let high = definitions.length;
          const offset = node.range?.[0] ?? 0;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (definitions[middle].offset < offset) low = middle + 1;
            else high = middle;
          }
          return definitions[low - 1]?.node;
        };
        const replace = (node: unknown, value = '"[REDACTED]"', followAlias = true) => {
          if (!isNode(node) || !node.range) return;
          const [start, end] = node.range;
          edits.push({ start, end, text: value + (text.slice(start, end).endsWith("\n") ? "\n" : "") });
          if (followAlias && isAlias(node)) replace(resolved(node), value, false);
        };
        const scalar = (node: unknown) => {
          const target = resolved(node);
          return isScalar(target) ? String(target.value) : undefined;
        };
        const pairs = (node: unknown, depth: number, path = new Set<unknown>()): { key: unknown; value: unknown }[] => {
          if (--remaining < 0 || depth > 64) throw new RangeError("resource payload complexity limit");
          const target = resolved(node);
          if (path.has(target)) throw new RangeError("cyclic YAML merge");
          path.add(target);
          const result: { key: unknown; value: unknown }[] = [];
          const append = (entries: { key: unknown; value: unknown }[]) => {
            if (entries.length > remaining) throw new RangeError("resource payload complexity limit");
            remaining -= entries.length;
            result.push(...entries);
          };
          if (isSeq(target)) for (const child of target.items) append(pairs(child, depth + 1, path));
          else if (isMap(target))
            for (const pair of target.items) {
              if (scalar(pair.key) === "<<") append(pairs(pair.value, depth + 1, path));
              else append([pair]);
            }
          path.delete(target);
          return result;
        };
        const maskPayload = (node: unknown, depth: number) => {
          const target = resolved(node);
          if (!isMap(target)) {
            replace(node);
            return;
          }
          const entries = pairs(target, depth + 1);
          if (entries.length > remaining) throw new RangeError("resource payload complexity limit");
          if (isAlias(node)) {
            const keys = entries.map((pair) => scalar(pair.key));
            if (keys.some((key) => key === undefined)) replace(node);
            else replace(node, `{${keys.map((key) => `${JSON.stringify(key)}: "[REDACTED]"`).join(", ")}}`, false);
          }
          for (const pair of entries) {
            remaining--;
            replace(pair.value);
          }
        };
        const visit = (input: unknown, depth: number, resourceHint = false) => {
          if (--remaining < 0 || depth > 64) throw new RangeError("resource payload complexity limit");
          const node = resolved(input);
          if (ancestors.has(node)) throw new RangeError("cyclic YAML alias");
          ancestors.add(node);
          if (isMap(node)) {
            const entries = pairs(node, depth);
            const resource =
              resourceHint ||
              entries.some(
                (pair) => scalar(pair.key) === "kind" && ["Secret", "ConfigMap"].includes(scalar(pair.value) ?? ""),
              );
            const typedList = entries.some(
              (pair) =>
                scalar(pair.key) === "kind" && ["SecretList", "ConfigMapList"].includes(scalar(pair.value) ?? ""),
            );
            recognized ||= resource || typedList;
            for (const pair of entries) {
              const key = scalar(pair.key);
              if (resource && payloadFields.has(key ?? "")) maskPayload(pair.value, depth);
              else if (key === annotation) {
                const value = scalar(pair.value);
                try {
                  if (value === undefined) throw new Error("invalid resource annotation");
                  const safe = redactKubernetesJsonText(value);
                  if (safe !== value) replace(pair.value, JSON.stringify(safe));
                } catch {
                  replace(pair.value);
                }
              } else visit(pair.value, depth + 1, typedList && key === "items");
            }
          } else if (isSeq(node)) for (const child of node.items) visit(child, depth + 1, resourceHint);
          else if (
            isScalar(node) &&
            typeof node.value === "string" &&
            (node !== doc.contents || node.value.trim() !== source.trim())
          ) {
            try {
              const safe = redactKubernetesJsonText(node.value, encodedDepth + 1);
              if (safe !== node.value) replace(node, JSON.stringify(safe));
            } catch {
              const safe = redactKubernetesYamlText(node.value, encodedDepth + 1);
              if (safe !== node.value) replace(node, JSON.stringify(safe));
            }
          }
          ancestors.delete(node);
        };
        visit(doc.contents, 0);
        if (doc.errors.length && (recognized || recognizable(source))) throw new Error("malformed resource document");
      } catch (error) {
        if (doc.range && (error instanceof RangeError || recognized || recognizable(source)))
          edits.push({ start: doc.range[0], end: doc.range[2], text: '"[REDACTED]"\n' });
      }
    }
  } catch {
    return recognizable(text) ? JSON.stringify(REDACTED) : text;
  }
  let result = "";
  let position = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (edit.start < position) continue;
    result += text.slice(position, edit.start) + edit.text;
    position = edit.end;
  }
  return result + text.slice(position);
}
