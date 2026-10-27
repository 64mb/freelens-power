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

export type HelmDiffBlock =
  | { kind: "gap"; count: number }
  | { kind: "code"; before: string[]; after: string[]; beforeStart: number; afterStart: number; changed: boolean };

// keep native editor count bounded even for documents containing many tiny edits
export const MAX_HELM_DIFF_BLOCKS = 12;

export function buildHelmDiffBlocks(
  diff: Extract<HelmDiff, { available: true }>,
  full = false,
): HelmDiffBlock[] | undefined {
  const groups: { equal: boolean; lines: HelmDiffLine[] }[] = [];
  for (const line of diff.lines) {
    const equal = line.kind === "equal";
    const last = groups[groups.length - 1];
    if (last?.equal === equal) last.lines.push(line);
    else groups.push({ equal, lines: [line] });
  }
  const blocks: HelmDiffBlock[] = [];
  let beforeStart = 1;
  let afterStart = 1;
  function code(lines: HelmDiffLine[], changed: boolean) {
    const before = lines.filter((line) => line.kind !== "added").map((line) => line.text);
    const after = lines.filter((line) => line.kind !== "removed").map((line) => line.text);
    if (lines.length) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "code" && !last.changed && !changed) {
        last.before.push(...before);
        last.after.push(...after);
      } else blocks.push({ kind: "code", before, after, beforeStart, afterStart, changed });
    }
    beforeStart += before.length;
    afterStart += after.length;
  }
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    if (!group.equal || full) code(group.lines, !group.equal);
    else {
      const leading = index > 0 ? Math.min(3, group.lines.length) : 0;
      const trailing = index < groups.length - 1 ? Math.min(3, group.lines.length - leading) : 0;
      code(group.lines.slice(0, leading), false);
      const omitted = group.lines.length - leading - trailing;
      if (omitted) {
        blocks.push({ kind: "gap", count: omitted });
        beforeStart += omitted;
        afterStart += omitted;
      }
      code(trailing ? group.lines.slice(-trailing) : [], false);
    }
    if (blocks.length > MAX_HELM_DIFF_BLOCKS) return undefined;
  }
  return blocks;
}

export type HelmFindMatch = { source: "before" | "after"; line: number; column: number };
export function findHelmDocumentMatches(before: string, after: string, query: string) {
  const matches: HelmFindMatch[] = [];
  let count = 0;
  if (before.length > 2 * 1024 * 1024 || after.length > 2 * 1024 * 1024) {
    return { matches, count, available: false };
  }
  if (query) {
    for (const [source, text] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        let column = lines[index].indexOf(query);
        while (column >= 0) {
          count++;
          if (matches.length < 1000) matches.push({ source, line: index + 1, column: column + 1 });
          column = lines[index].indexOf(query, column + query.length);
        }
      }
    }
  }
  return { matches, count, available: true };
}
