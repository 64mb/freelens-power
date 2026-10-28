export type HelmDiffLine = { kind: "equal" | "added" | "removed"; text: string };
export type HelmLineRange = { start: number; end: number };
export type HelmDiff =
  | { available: false; reason: string }
  | {
      available: true;
      approximate?: true;
      lines: HelmDiffLine[];
      added: number;
      removed: number;
      beforeRanges: HelmLineRange[];
      afterRanges: HelmLineRange[];
    };

const MAX_CHARACTERS = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_CELLS = 1_000_000;

export function compareHelmLines(before: string, after: string, fullComparison = false): HelmDiff {
  const unavailable = {
    available: false as const,
    reason: "Detailed comparison exceeds the size limit. Documents are shown below without change highlighting.",
  };
  const characterLimit = fullComparison ? 16 * 1024 * 1024 : MAX_CHARACTERS;
  if (before.length > characterLimit || after.length > characterLimit) return unavailable;
  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");
  const lineLimit = fullComparison ? 200_000 : MAX_LINES;
  if (oldLines.length > lineLimit || newLines.length > lineLimit) return unavailable;
  if (fullComparison) return compareFullHelmLines(oldLines, newLines);
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
  for (let index = oldLines.length - suffix; index < oldLines.length; index++) {
    lines.push({ kind: "equal", text: oldLines[index] });
  }
  return summarizeHelmLines(lines);
}

function summarizeHelmLines(lines: HelmDiffLine[], approximate = false): HelmDiff {
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
  return {
    available: true,
    lines,
    added,
    removed,
    beforeRanges,
    afterRanges,
    ...(approximate ? { approximate: true as const } : {}),
  };
}

function compareFullHelmLines(before: string[], after: string[]): HelmDiff {
  const lines: HelmDiffLine[] = [];
  let cellsRemaining = 8_000_000;
  let approximate = false;
  function emit(kind: HelmDiffLine["kind"], source: string[], start: number, end: number) {
    for (let index = start; index < end; index++) lines.push({ kind, text: source[index] });
  }
  function compare(oldStart: number, oldEnd: number, newStart: number, newEnd: number, depth: number) {
    while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart]) {
      lines.push({ kind: "equal", text: before[oldStart++] });
      newStart++;
    }
    let suffix = 0;
    while (
      oldStart < oldEnd - suffix &&
      newStart < newEnd - suffix &&
      before[oldEnd - suffix - 1] === after[newEnd - suffix - 1]
    )
      suffix++;
    const oldStop = oldEnd - suffix;
    const newStop = newEnd - suffix;
    const oldCount = oldStop - oldStart;
    const newCount = newStop - newStart;
    const cells = (oldCount + 1) * (newCount + 1);
    if (!oldCount || !newCount) {
      emit("removed", before, oldStart, oldStop);
      emit("added", after, newStart, newStop);
    } else if (cells <= MAX_CELLS && cells <= cellsRemaining) {
      cellsRemaining -= cells;
      const width = newCount + 1;
      const lengths = new Uint32Array(cells);
      for (let old = oldCount - 1; old >= 0; old--) {
        for (let next = newCount - 1; next >= 0; next--) {
          lengths[old * width + next] =
            before[oldStart + old] === after[newStart + next]
              ? lengths[(old + 1) * width + next + 1] + 1
              : Math.max(lengths[(old + 1) * width + next], lengths[old * width + next + 1]);
        }
      }
      let old = 0;
      let next = 0;
      while (old < oldCount || next < newCount) {
        if (old < oldCount && next < newCount && before[oldStart + old] === after[newStart + next]) {
          lines.push({ kind: "equal", text: before[oldStart + old++] });
          next++;
        } else if (
          old < oldCount &&
          (next === newCount || lengths[(old + 1) * width + next] >= lengths[old * width + next + 1])
        ) {
          lines.push({ kind: "removed", text: before[oldStart + old++] });
        } else lines.push({ kind: "added", text: after[newStart + next++] });
      }
    } else {
      const anchors: { old: number; next: number }[] = [];
      if (depth < 32) {
        const oldPositions = new Map<string, number>();
        const newPositions = new Map<string, number>();
        for (let index = oldStart; index < oldStop; index++)
          oldPositions.set(before[index], oldPositions.has(before[index]) ? -1 : index);
        for (let index = newStart; index < newStop; index++)
          newPositions.set(after[index], newPositions.has(after[index]) ? -1 : index);
        const candidates: { old: number; next: number }[] = [];
        for (let index = oldStart; index < oldStop; index++) {
          const next = newPositions.get(before[index]);
          if (oldPositions.get(before[index]) === index && next !== undefined && next >= 0)
            candidates.push({ old: index, next });
        }
        const tails: number[] = [];
        const previous = new Int32Array(candidates.length).fill(-1);
        for (let index = 0; index < candidates.length; index++) {
          let low = 0;
          let high = tails.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (candidates[tails[middle]].next < candidates[index].next) low = middle + 1;
            else high = middle;
          }
          if (low) previous[index] = tails[low - 1];
          tails[low] = index;
        }
        let index = tails.length ? tails[tails.length - 1] : -1;
        while (index >= 0) {
          anchors.push(candidates[index]);
          index = previous[index];
        }
        anchors.reverse();
      }
      if (anchors.length) {
        let old = oldStart;
        let next = newStart;
        for (const anchor of anchors) {
          compare(old, anchor.old, next, anchor.next, depth + 1);
          lines.push({ kind: "equal", text: before[anchor.old] });
          old = anchor.old + 1;
          next = anchor.next + 1;
        }
        compare(old, oldStop, next, newStop, depth + 1);
      } else {
        approximate = true;
        emit("removed", before, oldStart, oldStop);
        emit("added", after, newStart, newStop);
      }
    }
    emit("equal", before, oldStop, oldEnd);
  }
  compare(0, before.length, 0, after.length, 0);
  return summarizeHelmLines(lines, approximate);
}

export type HelmDiffBlock =
  | { kind: "gap"; count: number }
  | { kind: "code"; before: string[]; after: string[]; beforeStart: number; afterStart: number; changed: boolean };

// keep native editor count bounded even for documents containing many tiny edits
export const MAX_HELM_DIFF_CODE_BLOCKS = 12;

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
  let codeBlockCount = 0;
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
      } else {
        blocks.push({ kind: "code", before, after, beforeStart, afterStart, changed });
        codeBlockCount++;
      }
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
    if (codeBlockCount > MAX_HELM_DIFF_CODE_BLOCKS) return undefined;
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

export const MAX_HELM_PREVIEW_LINES = 1000;
export const MAX_HELM_PREVIEW_CHARACTERS = 256 * 1024;
export function helmDocumentPreview(document: string) {
  let end = Math.min(document.length, MAX_HELM_PREVIEW_CHARACTERS);
  let lines = 1;
  for (let index = 0; index < end; index++) {
    if (document.charCodeAt(index) !== 10) continue;
    if (lines === MAX_HELM_PREVIEW_LINES) {
      end = index;
      break;
    }
    lines++;
  }
  return { value: document.slice(0, end), lines, limited: end < document.length };
}
