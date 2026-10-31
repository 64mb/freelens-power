import { logColumnNames } from "./power-log-columns";

import type { JsonPath } from "../common/power-log-field-filters";
import type { LogRecord } from "../common/power-logs";

function textCells(text: string): number {
  let line = 0;
  let longest = 0;
  for (const character of text.slice(0, 256)) {
    const code = character.codePointAt(0)!;
    if (character === "\n" || character === "\r") {
      longest = Math.max(longest, line);
      line = 0;
    } else if (character === "\t") {
      line += 4;
    } else {
      line += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
    }
  }
  return Math.max(longest, line);
}

export function createLogColumnSizer(readColumn: (record: LogRecord, path: JsonPath) => string) {
  const widths = new Map<string, { name: string; percentage: number; valueCells: number }>();
  let previousCompact: boolean | undefined;
  return (
    records: readonly LogRecord[],
    paths: readonly JsonPath[],
    viewportWidth: number,
    compact: boolean,
  ): number[] => {
    if (previousCompact !== compact) widths.clear();
    previousCompact = compact;
    const names = logColumnNames(paths);
    const keys = paths.map((path) => JSON.stringify(path));
    const activeKeys = new Set(keys);
    for (const key of widths.keys()) {
      if (!activeKeys.has(key)) widths.delete(key);
    }
    const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 800;
    const cellWidth = (compact ? 11 : 12) * 0.6;
    return paths.map((path, index) => {
      const key = keys[index];
      const cached = widths.get(key);
      if (cached?.name === names[index]) return cached.percentage;
      const samples: number[] = [];
      const count = cached ? 0 : Math.min(records.length, 200);
      for (let sample = 0; sample < count; sample++) {
        const recordIndex = count === 1 ? 0 : Math.floor((sample * (records.length - 1)) / (count - 1));
        samples.push(textCells(readColumn(records[recordIndex], path)));
      }
      samples.sort((a, b) => a - b);
      const valueCells = cached?.valueCells ?? (samples.length ? samples[Math.ceil(samples.length * 0.9) - 1] : 0);
      const pixels = Math.max(textCells(names[index]) * cellWidth + 32, valueCells * cellWidth + 16);
      const percentage = Math.max(6, Math.min(25, (pixels / viewport) * 100));
      widths.set(key, { name: names[index], percentage, valueCells });
      return percentage;
    });
  };
}
