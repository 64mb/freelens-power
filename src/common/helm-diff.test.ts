import { describe, expect, it } from "vitest";
import { buildHelmDiffBlocks, compareHelmLines, findHelmDocumentMatches, helmDocumentPreview } from "./helm-diff";

describe("Helm line comparison", () => {
  it.each([
    ["", ""],
    ["a\nb", "a\nb"],
    ["", "a\n"],
    ["a\n", ""],
    ["first\nold\nlast", "first\nnew\nlast"],
    ["a\nb\na\nc\n", "b\na\nd\nc\n"],
    ["a\n", "a"],
  ])("reconstructs both documents exactly for %j and %j", (before, after) => {
    const diff = compareHelmLines(before, after);
    expect(diff.available).toBe(true);
    if (!diff.available) return;
    expect(
      diff.lines
        .filter((line) => line.kind !== "added")
        .map((line) => line.text)
        .join("\n"),
    ).toBe(before);
    expect(
      diff.lines
        .filter((line) => line.kind !== "removed")
        .map((line) => line.text)
        .join("\n"),
    ).toBe(after);
  });

  it("locates changed lines on each side without marking shared context", () => {
    const diff = compareHelmLines("a\nb\nc\nd", "a\nnew\nc\nextra\nd");
    expect(diff).toMatchObject({
      available: true,
      added: 2,
      removed: 1,
      beforeRanges: [{ start: 2, end: 2 }],
      afterRanges: [
        { start: 2, end: 2 },
        { start: 4, end: 4 },
      ],
    });
  });

  it("compares a localized edit in a large document", () => {
    const prefix = Array.from({ length: 8000 }, (_, index) => `key${index}: value`).join("\n");
    expect(compareHelmLines(`${prefix}\nold`, `${prefix}\nnew`)).toMatchObject({
      available: true,
      added: 1,
      removed: 1,
    });
  });

  it("bounds memory and work for completely different large documents", () => {
    const before = Array.from({ length: 5000 }, (_, index) => `old${index}`).join("\n");
    const after = Array.from({ length: 5000 }, (_, index) => `new${index}`).join("\n");
    expect(compareHelmLines(before, after)).toMatchObject({ available: false });
    expect(compareHelmLines("x".repeat(1024 * 1024 + 1), "")).toMatchObject({ available: false });
    expect(compareHelmLines("\n".repeat(20_001), "")).toMatchObject({ available: false });
  });
});

describe("Helm context blocks", () => {
  function blocks(before: string, after: string, full = false) {
    const diff = compareHelmLines(before, after);
    if (!diff.available) throw new Error("unexpected comparison bound");
    return buildHelmDiffBlocks(diff, full)!;
  }

  it("keeps three lines around changes and original document line numbers", () => {
    const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const target = [...source];
    target[10] = "replacement";
    const result = blocks(source.join("\n"), target.join("\n"));
    expect(result).toMatchObject([
      { kind: "gap", count: 7 },
      { kind: "code", beforeStart: 8, afterStart: 8, before: source.slice(7, 10), changed: false },
      { kind: "code", beforeStart: 11, afterStart: 11, before: ["line 11"], after: ["replacement"], changed: true },
      { kind: "code", beforeStart: 12, afterStart: 12, before: source.slice(11, 14), changed: false },
      { kind: "gap", count: 16 },
    ]);
  });

  it("merges overlapping context without duplicating original lines", () => {
    const source = Array.from({ length: 16 }, (_, index) => `${index}`);
    const target = [...source];
    target[4] = "first";
    target[9] = "second";
    const result = blocks(source.join("\n"), target.join("\n"));
    expect(result.filter((block) => block.kind === "gap")).toEqual([
      { kind: "gap", count: 1 },
      { kind: "gap", count: 3 },
    ]);
    expect(result.filter((block) => block.kind === "code").flatMap((block) => block.before)).toEqual(
      source.slice(1, 13),
    );
  });

  it.each([
    ["", "a\nb"],
    ["a\nb", ""],
  ])("aligns pure insertion or deletion without inventing opposite content", (before, after) => {
    expect(blocks(before, after)).toMatchObject([
      {
        kind: "code",
        before: before ? before.split("\n") : [],
        after: after ? after.split("\n") : [],
        beforeStart: 1,
        afterStart: 1,
      },
    ]);
  });

  it("maps following context after unequal replacement lengths", () => {
    expect(blocks("a\nold\nz", "a\nnew\nextra\nz")).toMatchObject([
      { kind: "code", beforeStart: 1, afterStart: 1 },
      { kind: "code", beforeStart: 2, afterStart: 2, before: ["old"], after: ["new", "extra"] },
      { kind: "code", beforeStart: 3, afterStart: 4, before: ["z"], after: ["z"] },
    ]);
  });

  it("expands complete documents only when requested", () => {
    const source = Array.from({ length: 12 }, (_, index) => `${index}`);
    expect(blocks(source.join("\n"), source.join("\n"))).toEqual([{ kind: "gap", count: 12 }]);
    expect(blocks(source.join("\n"), source.join("\n"), true)).toMatchObject([
      { kind: "code", before: source, after: source },
    ]);
  });

  it("bounds native editor count for fragmented comparisons", () => {
    const before = Array.from({ length: 200 }, (_, index) => `${index}`);
    const after = before.map((line, index) => (index % 2 ? line : `new ${line}`));
    const diff = compareHelmLines(before.join("\n"), after.join("\n"));
    if (!diff.available) throw new Error("unexpected comparison bound");
    expect(buildHelmDiffBlocks(diff)).toBeUndefined();
  });
});

it("finds original lines on both sides including hidden context and later hunks", () => {
  expect(findHelmDocumentMatches("hidden\nold\nhidden", "hidden\nnew\nhidden", "hidden")).toEqual({
    available: true,
    count: 4,
    matches: [
      { source: "before", line: 1, column: 1 },
      { source: "before", line: 3, column: 1 },
      { source: "after", line: 1, column: 1 },
      { source: "after", line: 3, column: 1 },
    ],
  });
  expect(findHelmDocumentMatches("aa aa", "", "aa").matches).toMatchObject([{ column: 1 }, { column: 4 }]);
});

it("bounds find navigation while reporting the full match count and oversized documents explicitly", () => {
  const result = findHelmDocumentMatches("x".repeat(1500), "x", "x");
  expect(result.count).toBe(1501);
  expect(result.matches).toHaveLength(1000);
  expect(findHelmDocumentMatches("x".repeat(2 * 1024 * 1024 + 1), "", "x").available).toBe(false);
});

it("keeps sparse edits in a long document within the editor bound without counting gap markers", () => {
  const before = Array.from({ length: 363 }, (_, index) => `key${index}: unchanged`);
  const after = [...before];
  for (const index of [25, 180, 330]) after[index] = `key${index}: changed`;
  const diff = compareHelmLines(before.join("\n"), after.join("\n"));
  if (!diff.available) throw new Error("unexpected comparison bound");
  const result = buildHelmDiffBlocks(diff)!;
  expect(result).toBeDefined();
  expect(result.filter((block) => block.kind === "code")).toHaveLength(9);
  expect(result.filter((block) => block.kind === "gap")).toHaveLength(4);
  expect(result.filter((block) => block.kind === "code" && block.changed)).toHaveLength(3);
  expect(result.filter((block) => block.kind === "code").flatMap((block) => block.before)).toHaveLength(21);
});

it("bounds document previews by lines and characters while preserving the exact original prefix", () => {
  const lines = Array.from({ length: 20000 }, (_, index) => `key${index}: value`).join("\n");
  expect(helmDocumentPreview(lines)).toEqual({
    value: lines.split("\n").slice(0, 1000).join("\n"),
    lines: 1000,
    limited: true,
  });
  const singleLine = "x".repeat(300000);
  expect(helmDocumentPreview(singleLine)).toEqual({ value: singleLine.slice(0, 256 * 1024), lines: 1, limited: true });
  expect(helmDocumentPreview("one\ntwo")).toEqual({ value: "one\ntwo", lines: 2, limited: false });
});
