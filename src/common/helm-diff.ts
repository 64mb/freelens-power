export type HelmDiffLine = { kind: "equal" | "added" | "removed"; text: string };
export type HelmLineRange = { start: number; end: number };
export type HelmDiff =
  | { available: false; reason: string }
  | {
      available: true;
      lines: HelmDiffLine[];
      added: number;
      removed: number;
      beforeRanges: HelmLineRange[];
      afterRanges: HelmLineRange[];
    };

const MAX_CHARACTERS = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_CELLS = 1_000_000;

export function compareHelmLines(before: string, after: string): HelmDiff {
  const unavailable = {
    available: false as const,
    reason: "Detailed comparison exceeds the size limit. Full documents are shown below without change highlighting.",
  };
  if (before.length > MAX_CHARACTERS || after.length > MAX_CHARACTERS) return unavailable;
  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) return unavailable;
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  )
    suffix++;
  const oldCount = oldLines.length - prefix - suffix;
  const newCount = newLines.length - prefix - suffix;
  if ((oldCount + 1) * (newCount + 1) > MAX_CELLS) return unavailable;
  const width = newCount + 1;
  const lengths = new Uint32Array((oldCount + 1) * width);
  for (let old = oldCount - 1; old >= 0; old--) {
    for (let next = newCount - 1; next >= 0; next--) {
      lengths[old * width + next] =
        oldLines[prefix + old] === newLines[prefix + next]
          ? lengths[(old + 1) * width + next + 1] + 1
          : Math.max(lengths[(old + 1) * width + next], lengths[old * width + next + 1]);
    }
  }
  const lines: HelmDiffLine[] = oldLines.slice(0, prefix).map((text) => ({ kind: "equal", text }));
  let old = 0;
  let next = 0;
  while (old < oldCount || next < newCount) {
    if (old < oldCount && next < newCount && oldLines[prefix + old] === newLines[prefix + next]) {
      lines.push({ kind: "equal", text: oldLines[prefix + old++] });
      next++;
    } else if (
      old < oldCount &&
      (next === newCount || lengths[(old + 1) * width + next] >= lengths[old * width + next + 1])
    ) {
      lines.push({ kind: "removed", text: oldLines[prefix + old++] });
    } else {
      lines.push({ kind: "added", text: newLines[prefix + next++] });
    }
  }
  lines.push(...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: "equal" as const, text })));
  const beforeRanges: HelmLineRange[] = [];
  const afterRanges: HelmLineRange[] = [];
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  function append(ranges: HelmLineRange[], line: number) {
    const last = ranges[ranges.length - 1];
    if (last?.end === line - 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  for (const line of lines) {
    if (line.kind === "removed") {
      append(beforeRanges, oldLine++);
      removed++;
    } else if (line.kind === "added") {
      append(afterRanges, newLine++);
      added++;
    } else {
      oldLine++;
      newLine++;
    }
  }
  return { available: true, lines, added, removed, beforeRanges, afterRanges };
}
