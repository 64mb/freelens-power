import { expect, it } from "vitest";
import {
  compactJsonLiteral,
  formatJsonLiteral,
  jsonFieldLiteral,
  jsonFields,
  jsonHasDuplicateKeys,
} from "./power-log-json-fields";

it("keeps special keys, prototype-like names, and array indices literal", () => {
  const text = '{"__proto__":{"a.b":[null,{"quote\\\"":"value"}]}}';
  const fields = [...jsonFields(text).values()].map(({ path, value }) => ({ path, value }));
  expect(fields).toContainEqual({ path: ["__proto__", "a.b", 0], value: null });
  expect(fields).toContainEqual({ path: ["__proto__", "a.b", 1, 'quote"'], value: "value" });
});

it("disables actions for truncated and excessively deep previews", () => {
  expect(jsonFields('{"a": [1,')).toEqual(new Map());
  expect(jsonFields("[".repeat(10000) + "0" + "]".repeat(10000))).toEqual(new Map());
});

it("detects duplicate decoded keys within each independent object scope", () => {
  expect(jsonHasDuplicateKeys('{"a":1,"a":2}')).toBe(true);
  expect(jsonHasDuplicateKeys('{"a":1,"\\u0061":2}')).toBe(true);
  expect(jsonHasDuplicateKeys('{"a":{"x":1},"b":{"x":2}}')).toBe(false);
  expect(jsonHasDuplicateKeys('[{"x":1},{"x":2}]')).toBe(false);
  expect(jsonHasDuplicateKeys('[{"x":1,"x":2}]')).toBe(true);
  expect(jsonHasDuplicateKeys(" ".repeat(2 * 1024 * 1024 + 1))).toBe(true);
  expect(jsonFields('{"a":1,"a":2}').size).toBe(0);
});

it("preserves numeric literals and escapes while compacting whitespace", () => {
  expect(compactJsonLiteral(' { "n": 9007199254740993, "large": 1e999, "s": "a b\\\\c" } ')).toBe(
    '{"n":9007199254740993,"large":1e999,"s":"a b\\\\c"}',
  );
  expect([...jsonFields('{"n":1e999}').values()]).toEqual([]);
});

it("extracts exact field literals and formats without changing numbers or escapes", () => {
  const text = '{"n": 9007199254740993,"container": {"x":1e999,"s":"a\\\\b"},"empty":[]}';
  const fields = jsonFields(text);
  const number = [...fields.values()].find((field) => field.path.join(".") === "n")!;
  const container = [...fields.values()].find((field) => field.path.join(".") === "container")!;
  expect(jsonFieldLiteral(text, number)).toBe("9007199254740993");
  expect(jsonFieldLiteral(text, container)).toBe('{"x":1e999,"s":"a\\\\b"}');
  expect(compactJsonLiteral(formatJsonLiteral(text))).toBe(compactJsonLiteral(text));
  const ordinary = { nested: [1, {}, [], "text"], absent: null };
  expect(formatJsonLiteral(JSON.stringify(ordinary))).toBe(JSON.stringify(ordinary, null, 2));
});
