import { expect, it } from "vitest";
import {
  extractJsonPath,
  type JSONValue,
  type JsonFieldFilter,
  jsonValuesEqual,
  matchesAllJsonFilters,
} from "./power-log-field-filters";

it("distinguishes missing, null, and differently typed values", () => {
  const fields = { present: null, text: "null", number: 1, flag: true };
  expect(extractJsonPath(fields, ["present"])).toEqual({ found: true, value: null });
  expect(extractJsonPath(fields, ["absent"])).toEqual({ found: false });
  expect(matchesAllJsonFilters(fields, [{ path: ["present"], operator: "eq", value: null }])).toBe(true);
  expect(matchesAllJsonFilters(fields, [{ path: ["absent"], operator: "eq", value: null }])).toBe(false);
  expect(matchesAllJsonFilters(fields, [{ path: ["absent"], operator: "neq", value: null }])).toBe(true);
  for (const [path, value] of [
    ["text", null],
    ["number", "1"],
    ["flag", "true"],
  ] as const) {
    expect(matchesAllJsonFilters(fields, [{ path: [path], operator: "eq", value }])).toBe(false);
    expect(matchesAllJsonFilters(fields, [{ path: [path], operator: "neq", value }])).toBe(true);
  }
});

it("uses literal path keys and numeric array indices", () => {
  const fields = { 'a.b["c"]': [{ "": { "quote'key": 42 } }] };
  expect(extractJsonPath(fields, ['a.b["c"]', 0, "", "quote'key"])).toEqual({ found: true, value: 42 });
  expect(extractJsonPath(fields, ["a", "b"])).toEqual({ found: false });
  for (const index of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0", "length"]) {
    expect(extractJsonPath(["value"], [index])).toEqual({ found: false });
  }
  expect(extractJsonPath({ "0": "value" }, [0])).toEqual({ found: false });
  expect(extractJsonPath(["value"], [1])).toEqual({ found: false });
  expect(extractJsonPath({}, new Array(1))).toEqual({ found: false });
});

it("reads only own data properties without prototype traversal or getters", () => {
  const fields = Object.create({ inherited: 1 });
  fields.own = 2;
  const getter = () => {
    throw new Error("must not invoke getters");
  };
  Object.defineProperty(fields, "accessor", { get: getter });
  expect(extractJsonPath(fields, ["inherited"])).toEqual({ found: false });
  expect(extractJsonPath(fields, ["own"])).toEqual({ found: true, value: 2 });
  expect(extractJsonPath(fields, ["accessor"])).toEqual({ found: false });
  const ownSpecial = JSON.parse('{"__proto__":{"constructor":{"prototype":"own value"}}}');
  expect(extractJsonPath(ownSpecial, ["__proto__", "constructor", "prototype"])).toEqual({
    found: true,
    value: "own value",
  });
  expect(extractJsonPath({}, ["constructor", "prototype"])).toEqual({ found: false });
});

it("compares objects structurally and arrays in order without coercion", () => {
  expect(jsonValuesEqual({ a: 1, b: [true, null] }, { b: [true, null], a: 1 })).toBe(true);
  expect(jsonValuesEqual([1, 2], [2, 1])).toBe(false);
  expect(jsonValuesEqual([1], { "0": 1 })).toBe(false);
  expect(jsonValuesEqual({ a: null }, {})).toBe(false);
  expect(jsonValuesEqual(null, "null")).toBe(false);
  expect(jsonValuesEqual(0, false)).toBe(false);
  expect(jsonValuesEqual(-0, 0)).toBe(true);
});

it("combines all filters with AND, including conflicting filters", () => {
  const fields = { service: "api", code: 503 };
  const filters: JsonFieldFilter[] = [
    { path: ["service"], operator: "eq", value: "api" },
    { path: ["code"], operator: "neq", value: 200 },
  ];
  expect(matchesAllJsonFilters(fields, filters)).toBe(true);
  expect(matchesAllJsonFilters(fields, [...filters, { path: ["service"], operator: "neq", value: "api" }])).toBe(false);
  expect(matchesAllJsonFilters(fields, [...filters, { path: ["code"], operator: "eq", value: 200 }])).toBe(false);
  expect(matchesAllJsonFilters(fields, [])).toBe(true);
  expect(matchesAllJsonFilters(fields, [{ path: [], operator: "eq", value: fields }])).toBe(true);
});

it("handles deep JSON iteratively and rejects cyclic or non-JSON values", () => {
  let left: JSONValue = null;
  let right: JSONValue = null;
  for (let i = 0; i < 12000; i++) {
    left = [left];
    right = [right];
  }
  expect(jsonValuesEqual(left, right)).toBe(true);
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const value of [cycle, undefined, NaN, Infinity, new Date(), new Array(1), { bad: undefined }]) {
    expect(jsonValuesEqual(value, value)).toBe(false);
  }
  const getter = Object.defineProperty({}, "a", {
    enumerable: true,
    get: () => {
      throw new Error("getter");
    },
  });
  expect(jsonValuesEqual(getter, {})).toBe(false);
});

it("rejects malformed filter input rather than treating it as a negative match", () => {
  for (const filter of [
    null,
    { path: [-1], operator: "neq", value: null },
    { path: [], operator: "other", value: null },
    { path: [], operator: "neq", value: undefined },
  ]) {
    expect(matchesAllJsonFilters({}, [filter] as JsonFieldFilter[])).toBe(false);
  }
});
