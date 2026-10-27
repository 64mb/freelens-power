import { describe, expect, it } from "vitest";
import { compareHelmLines } from "./helm-diff";

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
