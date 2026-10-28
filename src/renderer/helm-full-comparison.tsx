import { Renderer } from "@freelensapp/extensions";
import { clipboard } from "electron";
import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import { compareHelmLines, type HelmDiff, type HelmLineRange } from "../common/helm-diff";
import { NativeTooltip } from "./native-tooltip";

const { Button, Icon } = Renderer.Component;
type Row = { before?: string; after?: string; beforeLine?: number; afterLine?: number; changed: boolean };
function alignedRows(diff: Extract<HelmDiff, { available: true }>) {
  const rows: Row[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  for (let index = 0; index < diff.lines.length; ) {
    const line = diff.lines[index];
    if (line.kind === "equal") {
      rows.push({
        before: line.text,
        after: line.text,
        beforeLine: beforeLine++,
        afterLine: afterLine++,
        changed: false,
      });
      index++;
      continue;
    }
    const before: string[] = [];
    const after: string[] = [];
    while (index < diff.lines.length && diff.lines[index].kind !== "equal") {
      const item = diff.lines[index++];
      (item.kind === "removed" ? before : after).push(item.text);
    }
    for (let offset = 0; offset < Math.max(before.length, after.length); offset++)
      rows.push({
        before: before[offset],
        after: after[offset],
        beforeLine: offset < before.length ? beforeLine++ : undefined,
        afterLine: offset < after.length ? afterLine++ : undefined,
        changed: true,
      });
  }
  return rows;
}
export type FullComparisonDocument = {
  value: string;
  numbers: string[];
  ranges: HelmLineRange[];
  source: boolean;
  height: number;
  window: number;
};
export function HelmFullComparison({
  before,
  after,
  beforeLabel,
  afterLabel,
  viewport,
  renderDocument,
  onClose,
}: {
  before: string;
  after: string;
  beforeLabel: ReactNode;
  afterLabel: ReactNode;
  viewport: RefObject<HTMLDivElement>;
  renderDocument: (document: FullComparisonDocument) => ReactNode;
  onClose: () => void;
}) {
  const [result, setResult] = useState<{ diff: HelmDiff; rows: Row[] }>();
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [change, setChange] = useState(-1);
  const [copyStatus, setCopyStatus] = useState("");
  const [viewportHeight, setViewportHeight] = useState(600);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 600);
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [viewport]);
  useEffect(() => {
    let live = true;
    setResult(undefined);
    setError("");
    setOffset(0);
    setChange(-1);
    const timer = setTimeout(() => {
      try {
        const diff = compareHelmLines(before, after, true);
        if (live) setResult({ diff, rows: diff.available ? alignedRows(diff) : [] });
      } catch {
        if (live) setError("Unable to complete the comparison. Copy the full documents to compare them externally.");
      }
    }, 16);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [before, after]);
  const changes = useMemo(
    () => result?.rows.flatMap((row, index, rows) => (row.changed && !rows[index - 1]?.changed ? [index] : [])) ?? [],
    [result],
  );
  const jump = (direction: number) => {
    const next =
      change < 0 ? (direction > 0 ? 0 : changes.length - 1) : (change + direction + changes.length) % changes.length;
    setChange(next);
    const row = changes[next];
    setOffset(Math.max(0, Math.floor(row / 100) * 100 - 100));
    if (viewport.current) viewport.current.scrollTop = row * 18;
  };
  const copy = (source: boolean) => {
    try {
      clipboard.writeText(source ? before : after);
      setCopyStatus("Full document copied");
    } catch {
      setCopyStatus("Could not copy the document. Try copying again.");
    }
  };
  const copyButton = (source: boolean) => {
    const title = `Copy full ${source ? "source" : "target"} document`;
    return (
      <NativeTooltip title={title}>
        <button type="button" className="helm-icon-button" aria-label={title} onClick={() => copy(source)}>
          <Icon material="content_copy" size={18} aria-hidden="true" />
        </button>
      </NativeTooltip>
    );
  };
  const rows = result?.rows ?? [];
  const count = Math.ceil(viewportHeight / 18) + 200;
  const end = Math.min(rows.length, offset + count);
  const visible = rows.slice(offset, end);
  const document = (source: boolean): FullComparisonDocument => ({
    source,
    window: offset,
    height: visible.length * 18 + 14,
    value: visible.map((row) => (source ? row.before : row.after) ?? "").join("\n"),
    numbers: visible.map((row) => String((source ? row.beforeLine : row.afterLine) ?? "")),
    ranges: visible.flatMap((row, index) =>
      row.changed && (source ? row.beforeLine : row.afterLine) !== undefined
        ? [{ start: index + 1, end: index + 1 }]
        : [],
    ),
  });
  return (
    <>
      <div className="helm-diff-summary" aria-live="polite">
        {!result && !error && (
          <span role="status">
            <Icon material="autorenew" size={16} aria-hidden="true" /> Comparing full documents…
          </span>
        )}
        {error && <span role="alert">{error}</span>}
        {result && !result.diff.available && (
          <span role="alert">
            Full comparison exceeds the 16 MiB or 200,000 line limit per document. Copy the full documents to compare
            them externally.
          </span>
        )}
        {result?.diff.available && (
          <>
            {!result.diff.added && !result.diff.removed ? (
              <strong>No changes in full documents</strong>
            ) : (
              <strong>
                Full comparison · {result.diff.added} added · {result.diff.removed} removed
              </strong>
            )}
            {result.diff.approximate && (
              <span>Some changed regions are grouped because exact line matching is too complex.</span>
            )}
            {!!changes.length && (
              <>
                <Button label="Previous change" onClick={() => jump(-1)} />
                <Button label="Next change" onClick={() => jump(1)} />
                <span>
                  {change < 0 ? `${changes.length} change regions` : `Change ${change + 1} of ${changes.length}`}
                </span>
              </>
            )}
          </>
        )}
        <Button label="Back to compact comparison" onClick={onClose} />
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
      <div
        ref={viewport}
        className="helm-diff-scroll"
        tabIndex={0}
        aria-label="Full comparison documents"
        onScroll={(event) => setOffset(Math.max(0, Math.floor(event.currentTarget.scrollTop / 18 / 100) * 100 - 100))}
      >
        <div className="helm-diff-panes helm-diff-headers">
          <h4>
            <span className="helm-diff-heading-label">{beforeLabel}</span>
            {copyButton(true)}
          </h4>
          <h4>
            <span className="helm-diff-heading-label">{afterLabel}</span>
            {copyButton(false)}
          </h4>
        </div>
        {!!rows.length && (
          <>
            <div style={{ height: offset * 18 }} aria-hidden="true" />
            <div className="helm-diff-panes">
              <div className="helm-diff-pane">{renderDocument(document(true))}</div>
              <div className="helm-diff-pane">{renderDocument(document(false))}</div>
            </div>
            <div style={{ height: Math.max(0, rows.length - end) * 18 }} aria-hidden="true" />
          </>
        )}
      </div>
    </>
  );
}
