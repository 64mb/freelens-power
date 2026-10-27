import { access, readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as yaml from "yaml";

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return { ...actual, parseDocument: vi.fn(actual.parseDocument) };
});

import { chartChoices, validateHelmValues, withHelmValues } from "./helm-values";

describe("Helm values safety", () => {
  it("accepts a mapping and rejects invalid, multiple and unknown-tag YAML", () => {
    expect(() => validateHelmValues("replicas: 2\nimage:\n  tag: stable\n")).not.toThrow();
    for (const value of [
      "[]",
      "null",
      "a: [",
      "a: 1\n---\nb: 2",
      "a: 1\na: 2",
      "a: !unsafe x",
      "a: " + "x".repeat(1024 * 1024),
    ])
      expect(() => validateHelmValues(value)).toThrow();
  });
  it("accepts ordinary anchors and property names without assigning object prototypes", () => {
    expect(() => validateHelmValues("defaults: &defaults {replicas: 2}\ncopy: *defaults\n")).not.toThrow();
    expect(() =>
      validateHelmValues("__proto__: {constructor: safe}\nprototype: value\nconstructor: value\n"),
    ).not.toThrow();
    expect(Object.prototype).not.toHaveProperty("replicas");
  });
  it("rejects cycles, alias bombs and excessive expanded depth or node counts", () => {
    expect(() => validateHelmValues("a: &a [*a]\n")).toThrow();
    let bomb = "a: &a [value, value]\n";
    for (let i = 1; i < 12; i++)
      bomb += `a${i}: &a${i} [*${i === 1 ? "a" : `a${i - 1}`}, *${i === 1 ? "a" : `a${i - 1}`}]\n`;
    expect(() => validateHelmValues(bomb)).toThrow();
    expect(() => validateHelmValues("a: " + "[".repeat(65) + "0" + "]".repeat(65))).toThrow();
    let deepAliases = "a0: &a0 [0]\n";
    for (let i = 1; i < 70; i++) deepAliases += `a${i}: &a${i} [*a${i - 1}]\n`;
    expect(() => validateHelmValues(deepAliases)).toThrow();
    const large = "a: [" + "0,".repeat(100_001) + "]";
    expect(() => validateHelmValues(large)).toThrow();
  });
  it("validates wide mappings with linear duplicate checks instead of parser pairwise comparisons", () => {
    const parse = vi.mocked(yaml.parseDocument);
    parse.mockClear();
    {
      const wide = Array.from({ length: 16_000 }, (_, i) => `setting${i}: value`).join("\n");
      expect(() => validateHelmValues(wide)).not.toThrow();
      expect(parse).toHaveBeenCalledWith(wide, { uniqueKeys: false });
      expect(() => validateHelmValues(`${wide}\nsetting15999: duplicate`)).toThrow();
    }
  });
  it("bounds alias resolution work before converting documents", () => {
    const aliases = (count: number) =>
      Array.from({ length: count }, (_, i) => `anchor${i}: &a${i} value\nalias${i}: *a${i}`).join("\n");
    expect(() => validateHelmValues(aliases(100))).not.toThrow();
    const parse = vi.mocked(yaml.parseDocument);
    const convert = vi.fn(() => {
      throw new Error("conversion should not run");
    });
    parse.mockImplementationOnce((...args) => {
      const document = yaml.parseAllDocuments(args[0], args[1])[0];
      document.toJS = convert;
      return document as ReturnType<typeof yaml.parseDocument>;
    });
    expect(() => validateHelmValues(aliases(101))).toThrow();
    expect(convert).not.toHaveBeenCalled();
  });
  it("limits choices to exact registered chart names and versions", () => {
    const rows = [
      { name: "stable/example", version: "1.2.3" },
      { name: "stable/example", version: "1.2.3" },
      { name: "stable/example", version: "1.2.4" },
      { name: "stable/example-extra", version: "1.2.3" },
      { name: "https://host/example", version: "1.2.3" },
      { name: "../example", version: "1.2.3" },
    ];
    expect(chartChoices(JSON.stringify(rows), "example", "1.2.3")).toEqual([
      { ref: "stable/example", version: "1.2.3" },
    ]);
  });
  it("creates private temporary values and removes them after success or failure", async () => {
    let saved = "";
    await withHelmValues("replicas: 2", async (path) => {
      saved = path;
      expect(await readFile(path, "utf8")).toBe("replicas: 2");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(path.substring(0, path.lastIndexOf("/")))).mode & 0o777).toBe(0o700);
    });
    await expect(access(saved)).rejects.toThrow();
    await expect(
      withHelmValues("{}", async (path) => {
        saved = path;
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    await expect(access(saved)).rejects.toThrow();
  });
});
