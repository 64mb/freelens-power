import { isMap, isScalar, parseDocument, visit } from "yaml";

export function helmValuesValidationError(values: string): string | undefined {
  const invalid = () => new Error("Values must be a valid YAML mapping within 1 MiB and within expansion limits");
  try {
    if (values.length > 1024 * 1024 || new TextEncoder().encode(values).length > 1024 * 1024) throw invalid();
    const document = parseDocument(values, { uniqueKeys: false });
    if (document.errors.length || !isMap(document.contents)) throw invalid();
    let nodes = 0;
    let aliases = 0;
    visit(document, {
      Alias() {
        if (++aliases > 100) throw invalid();
      },
      Map(_key, map) {
        const keys = new Set<string>();
        for (const pair of map.items) {
          if (!isScalar(pair.key)) throw invalid();
          const key = String(pair.key.value);
          if (keys.has(key)) throw invalid();
          keys.add(key);
        }
      },
      Node(_key, _node, path) {
        if (++nodes > 100_000 || path.length > 128) throw invalid();
      },
    });
    const expanded = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
    const active = new Set<object>();
    nodes = 0;
    const validate = (value: unknown, depth: number) => {
      if (++nodes > 100_000 || depth > 64) throw invalid();
      if (!value || typeof value !== "object") return;
      if (active.has(value)) throw invalid();
      active.add(value);
      if (value instanceof Map) {
        for (const [key, child] of value) {
          validate(key, depth + 1);
          validate(child, depth + 1);
        }
      } else if (Array.isArray(value)) {
        for (const child of value) validate(child, depth + 1);
      } else throw invalid();
      active.delete(value);
    };
    validate(expanded, 0);
    if (document.warnings.length) throw invalid();
  } catch {
    return invalid().message;
  }
  return undefined;
}
