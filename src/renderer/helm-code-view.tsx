import { Renderer } from "@freelensapp/extensions";
import { clipboard } from "electron";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildHelmDiffBlocks,
  compareHelmLines,
  findHelmDocumentMatches,
  type HelmLineRange,
  helmDocumentPreview,
  MAX_HELM_PREVIEW_CHARACTERS,
  MAX_HELM_PREVIEW_LINES,
} from "../common/helm-diff";
import { NativeTooltip } from "./native-tooltip";

const { MonacoEditor, Checkbox, Button, Icon } = Renderer.Component;
type NativeProps = ComponentProps<typeof MonacoEditor>;
type Model = Parameters<NonNullable<NativeProps["onModelChange"]>>[0];
function disposeDetachedModel(model?: Model) {
  if (!model) return;
  // let native editor reactions and unmount finish before disposing their model
  setTimeout(() => {
    if (!model.isDisposed()) model.dispose();
  }, 0);
}

let editorSequence = 0;
const editorSession = Math.random().toString(36).slice(2);

export function createHelmHorizontalScroll() {
  const viewports = new Set<HTMLElement>();
  const expected = new Map<HTMLElement, number>();
  let offset = 0;
  const apply = (viewport: HTMLElement) => {
    if (viewport.scrollLeft === offset) return;
    viewport.scrollLeft = offset;
    expected.set(viewport, viewport.scrollLeft);
  };
  return {
    register(viewport: HTMLElement) {
      viewports.add(viewport);
      apply(viewport);
      const scroll = () => {
        const left = viewport.scrollLeft;
        const pending = expected.get(viewport);
        expected.delete(viewport);
        if (left === pending || left === offset) return;
        offset = left;
        for (const peer of viewports) if (peer !== viewport) apply(peer);
      };
      const wheel = (event: WheelEvent) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
        const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        if (!delta || (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX))) return;
        const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientWidth : 1;
        const next = Math.max(
          0,
          Math.min(Math.max(0, viewport.scrollWidth - viewport.clientWidth), viewport.scrollLeft + delta * scale),
        );
        if (next === viewport.scrollLeft || !Number.isFinite(next)) return;
        viewport.scrollLeft = next;
        scroll();
        event.preventDefault();
        event.stopPropagation();
      };
      viewport.addEventListener("scroll", scroll);
      viewport.addEventListener("wheel", wheel, { capture: true, passive: false });
      return () => {
        viewport.removeEventListener("scroll", scroll);
        viewport.removeEventListener("wheel", wheel, true);
        viewports.delete(viewport);
        expected.delete(viewport);
      };
    },
    refresh() {
      for (const viewport of viewports) apply(viewport);
    },
  };
}

type HelmHorizontalScroll = {
  controller: ReturnType<typeof createHelmHorizontalScroll>;
  width: number;
  onWidth: (width: number) => void;
};

function HelmHorizontalBar({ horizontal, source }: { horizontal: HelmHorizontalScroll; source: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    return root ? horizontal.controller.register(root) : undefined;
  }, [horizontal.controller]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setOverflow(root.scrollWidth > root.clientWidth);
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [horizontal.width]);
  return (
    <div
      ref={rootRef}
      className="helm-diff-horizontal-scroll"
      tabIndex={overflow ? 0 : -1}
      aria-hidden={!overflow}
      aria-label={source ? "Source horizontal scroll" : "Target horizontal scroll"}
      style={{ height: overflow ? 16 : 0 }}
    >
      <div style={{ width: horizontal.width || "100%", height: 1 }} />
    </div>
  );
}

type HelmCodeViewProps = {
  value: string;
  language?: "yaml" | "json";
  readOnly?: boolean;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  changeRanges?: HelmLineRange[];
  changeKind?: "added" | "removed";
  startLine?: number;
  expanded?: boolean;
  horizontal?: HelmHorizontalScroll;
};

let forwardingFind = false;

export function openHelmDocumentFind(container: HTMLElement): boolean {
  if (forwardingFind) return false;
  const comparison = container.matches(".helm-revision-diff")
    ? container
    : container.querySelector(".helm-revision-diff");
  if (comparison) {
    const event = new Event("helm-document-find", { cancelable: true });
    comparison.dispatchEvent(event);
    if (event.defaultPrevented) return true;
  }
  const inputs = Array.from(
    container.querySelectorAll<HTMLElement>(".helm-code-view textarea, .helm-code-view [role='textbox']"),
  );
  const input = inputs.find((candidate) => candidate === document.activeElement) ?? inputs[0];
  if (!input) return false;
  input.focus({ preventScroll: true });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    keyCode: 70,
    which: 70,
    ctrlKey: !mac,
    metaKey: mac,
    bubbles: true,
    cancelable: true,
  });
  forwardingFind = true;
  try {
    input.dispatchEvent(event);
    return event.defaultPrevented;
  } finally {
    forwardingFind = false;
  }
}

export function bindHelmDiffWheel(viewport: HTMLElement) {
  const scroll = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    )
      return;
    const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const previous = viewport.scrollTop;
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const next = Math.max(0, Math.min(maximum, previous + event.deltaY * scale));
    if (next === previous || !Number.isFinite(next)) return;
    viewport.scrollTop = next;
    event.preventDefault();
    event.stopPropagation();
  };
  viewport.addEventListener("wheel", scroll, { capture: true, passive: false });
  return () => viewport.removeEventListener("wheel", scroll, true);
}

export function HelmCodeView({
  value,
  language = "yaml",
  readOnly = true,
  onChange,
  ariaLabel = "Helm document",
  className = "",
  style,
  changeRanges = [],
  changeKind = "added",
  startLine = 1,
  expanded = false,
  horizontal,
}: HelmCodeViewProps) {
  const [identity] = useState(() => `power-helm-${editorSession}-${++editorSequence}`);
  const [ready, setReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusHandoff = useRef<{
    active: Element | null;
    scroll: { element: Element; top: number; left: number }[];
  }>();
  const modelRef = useRef<Model>();
  const decorations = useRef<string[]>([]);
  const layoutChrome = useRef<number>();
  const contentWidth = useRef<number>();
  const reportWidth = () => {
    if (layoutChrome.current !== undefined && contentWidth.current !== undefined)
      horizontal?.onWidth(Math.ceil(layoutChrome.current + contentWidth.current));
  };
  useEffect(() => {
    const root = rootRef.current;
    return root && horizontal ? horizontal.controller.register(root) : undefined;
  }, [horizontal?.controller, ready]);
  const applyDecorations = useCallback(
    (model: Model) => {
      decorations.current = model.deltaDecorations(
        decorations.current,
        changeRanges.map(({ start, end }) => ({
          range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: `helm-diff-line-${changeKind}`,
            linesDecorationsClassName: `helm-diff-gutter-${changeKind}`,
          },
        })),
      );
    },
    [changeRanges, changeKind],
  );
  const onModelChange = useCallback(
    (model: Model, previous?: Model) => {
      modelRef.current = model;
      decorations.current = [];
      applyDecorations(model);
      disposeDetachedModel(previous);
      const handoff = focusHandoff.current;
      focusHandoff.current = undefined;
      if (handoff) {
        // native model changes focus the editor even for read-only documents
        if (handoff.active instanceof HTMLElement && handoff.active.isConnected && handoff.active !== document.body) {
          handoff.active.focus({ preventScroll: true });
        }
        if (document.activeElement instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        for (const position of handoff.scroll) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
      }
    },
    [applyDecorations],
  );
  useEffect(() => {
    if (readOnly) {
      const scroll: { element: Element; top: number; left: number }[] = [];
      for (let element: Element | null = rootRef.current; element; element = element.parentElement) {
        scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      focusHandoff.current = { active: document.activeElement, scroll };
    }
    // changing [id] makes the public model callback expose the initial model too
    setReady(true);
    return () => {
      disposeDetachedModel(modelRef.current);
    };
  }, []);
  useEffect(() => {
    if (modelRef.current) applyDecorations(modelRef.current);
  }, [applyDecorations, value]);
  return (
    <div
      ref={rootRef}
      className={`helm-code-view ${horizontal ? "helm-code-view-horizontal" : ""} ${className}`}
      style={{
        height: `min(52vh, ${Math.max(readOnly ? 140 : 240, value.split("\n", 30).length * 18 + 28)}px)`,
        minHeight: readOnly ? 140 : 240,
        minWidth: 0,
        overflow: "hidden",
        ...(horizontal ? ({ overflowX: "auto" } as CSSProperties) : {}),
        ...style,
      }}
    >
      <MonacoEditor
        id={`${identity}-${ready ? "document" : "initial"}`}
        // native size subscriptions start after creation, so the first document arrives through the model handoff
        value={horizontal && !ready ? "" : value}
        language={language}
        readOnly={readOnly}
        onChange={readOnly ? undefined : onChange}
        onModelChange={onModelChange}
        style={{
          height: "100%",
          width:
            horizontal && !ready
              ? horizontal.width
                ? Math.max(1, horizontal.width - 1)
                : "calc(100% - 1px)"
              : horizontal?.width || "100%",
        }}
        onDidLayoutChange={
          horizontal
            ? (layout) => {
                layoutChrome.current = layout.width - layout.contentWidth;
                reportWidth();
              }
            : undefined
        }
        onDidContentSizeChange={
          horizontal
            ? (event) => {
                contentWidth.current = event.contentWidth;
                reportWidth();
              }
            : undefined
        }
        options={{
          readOnly,
          ariaLabel,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          // use native textarea input to avoid [EditContext] stalls on multiline input in Electron
          editContext: false,
          // native [WordHighlighter] rejects pending delayed work when an editor closes
          occurrencesHighlight: "off",
          selectionHighlight: false,
          lineNumbers: (line) => String(startLine + line - 1),
          lineNumbersMinChars: 5,
          lineHeight: 18,
          scrollbar: expanded
            ? { vertical: "hidden", ...(horizontal ? { horizontal: "hidden" } : {}), alwaysConsumeMouseWheel: false }
            : undefined,
          wordWrap: "off",
          fontSize: 12,
          padding: expanded ? { top: 0, bottom: 0 } : { top: 12, bottom: 12 },
        }}
      />
    </div>
  );
}

export function HelmRevisionDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  language = "yaml",
}: {
  before: string;
  after: string;
  beforeLabel: ReactNode;
  afterLabel: ReactNode;
  language?: "yaml" | "json";
}) {
  const diff = useMemo(() => compareHelmLines(before, after), [before, after]);
  const horizontalController = useMemo(() => createHelmHorizontalScroll(), [before, after]);
  const [horizontalMeasurement, setHorizontalMeasurement] = useState({ before, after, width: 0 });
  const horizontalWidth =
    horizontalMeasurement.before === before && horizontalMeasurement.after === after ? horizontalMeasurement.width : 0;
  const onHorizontalWidth = useCallback(
    (width: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      setHorizontalMeasurement((current) =>
        current.before !== before || current.after !== after
          ? { before, after, width }
          : width > current.width
            ? { ...current, width }
            : current,
      );
    },
    [before, after],
  );
  const horizontal = useMemo(
    () => ({ controller: horizontalController, width: horizontalWidth, onWidth: onHorizontalWidth }),
    [horizontalController, horizontalWidth, onHorizontalWidth],
  );
  useEffect(() => horizontalController.refresh(), [horizontalController, horizontalWidth]);
  const [full, setFull] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const findOverlayEscapes = useRef(new WeakSet<KeyboardEvent>());
  const search = useMemo(() => findHelmDocumentMatches(before, after, query), [before, after, query]);
  const match = search.matches[matchIndex % (search.matches.length || 1)];
  const openFind = useCallback(() => {
    setFindOpen(true);
    setTimeout(() => findRef.current?.focus(), 0);
  }, []);
  useEffect(() => {
    const section = sectionRef.current;
    const open = (event: Event) => {
      event.preventDefault();
      openFind();
    };
    section?.addEventListener("helm-document-find", open);
    return () => section?.removeEventListener("helm-document-find", open);
  }, [openFind]);
  useEffect(() => {
    if (!match || !findOpen) return;
    const viewport = sectionRef.current?.querySelector<HTMLElement>(".helm-diff-scroll");
    const candidates = sectionRef.current?.querySelectorAll<HTMLElement>(`[data-helm-${match.source}-start]`);
    if (!viewport || !candidates) return;
    for (const block of Array.from(candidates)) {
      const start = Number(block.getAttribute(`data-helm-${match.source}-start`));
      const count = Number(block.getAttribute(`data-helm-${match.source}-count`));
      if (match.line >= start && match.line < start + count) {
        const headerHeight =
          sectionRef.current?.querySelector(".helm-diff-headers")?.getBoundingClientRect().height ?? 0;
        viewport.scrollTop +=
          block.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          (match.line - start) * 18 -
          headerHeight -
          8;
        break;
      }
    }
  }, [match, findOpen, full]);
  useEffect(() => {
    if (!findOpen) return;
    const capture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const overlay = document.querySelector(
        ".Select__menu, .helm-release-actions-menu, [data-testid='confirmation-dialog']",
      );
      if (overlay && !overlay.contains(sectionRef.current)) findOverlayEscapes.current.add(event);
    };
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || findOverlayEscapes.current.has(event)) return;
      const overlay = document.querySelector(
        ".Select__menu, .helm-release-actions-menu, [data-testid='confirmation-dialog']",
      );
      if (overlay && !overlay.contains(sectionRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      setFindOpen(false);
    };
    window.addEventListener("keydown", capture, true);
    document.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", capture, true);
      document.removeEventListener("keydown", close);
    };
  }, [findOpen]);
  const blocks = useMemo(() => (diff.available ? buildHelmDiffBlocks(diff, full) : undefined), [diff, full]);
  const matchVisible =
    match &&
    blocks?.some(
      (block) =>
        block.kind === "code" &&
        (match.source === "before"
          ? match.line >= block.beforeStart && match.line < block.beforeStart + block.before.length
          : match.line >= block.afterStart && match.line < block.afterStart + block.after.length),
    );
  const unchanged = diff.available && !diff.added && !diff.removed;
  const displayLimited = Boolean(
    blocks &&
      (blocks.reduce(
        (sum, block) => sum + (block.kind === "code" ? Math.max(block.before.length, block.after.length) : 0),
        0,
      ) > MAX_HELM_PREVIEW_LINES ||
        blocks.reduce(
          (sum, block) =>
            sum + (block.kind === "code" ? block.before.join("\n").length + block.after.join("\n").length : 0),
          0,
        ) > MAX_HELM_PREVIEW_CHARACTERS),
  );
  const fallback = !diff.available || !blocks || displayLimited;
  const previews = useMemo(
    () => (fallback ? { before: helmDocumentPreview(before), after: helmDocumentPreview(after) } : undefined),
    [before, after, fallback],
  );
  const [copyStatus, setCopyStatus] = useState("");
  const copyDocument = (source: boolean) => {
    try {
      clipboard.writeText(source ? before : after);
      setCopyStatus("Full document copied");
    } catch {
      setCopyStatus("Could not copy the document. Try copying again.");
    }
  };
  const fallbackHeight = previews ? Math.max(previews.before.lines, previews.after.lines) * 18 + 14 : 0;
  useEffect(() => {
    const viewport = viewportRef.current;
    return viewport ? bindHelmDiffWheel(viewport) : undefined;
  }, [unchanged, full, fallback]);
  const label = (value: ReactNode, source: boolean) =>
    typeof value === "string" ? value : source ? "Comparison source document" : "Comparison target document";
  const renderCode = (value: string[], start: number, source: boolean, changed: boolean, height: number) =>
    value.length ? (
      <HelmCodeView
        value={value.join("\n")}
        language={language}
        ariaLabel={label(source ? beforeLabel : afterLabel, source)}
        startLine={start}
        horizontal={horizontal}
        expanded
        changeKind={source ? "removed" : "added"}
        changeRanges={changed ? [{ start: 1, end: value.length }] : []}
        style={{ height, minHeight: 0 }}
      />
    ) : (
      <div className="helm-diff-empty" style={{ height }} aria-label="No corresponding lines" />
    );
  return (
    <section
      ref={sectionRef}
      className="helm-revision-diff"
      aria-label="Revision comparison"
      onKeyDownCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          openFind();
        } else if (findOpen && event.key === "Escape") {
          if (findOverlayEscapes.current.has(event.nativeEvent)) return;
          if (document.querySelector(".Select__menu, .helm-release-actions-menu")) return;
          event.preventDefault();
          event.stopPropagation();
          setFindOpen(false);
        }
      }}
    >
      <style>{`
      .helm-revision-diff { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
      .helm-diff-summary { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 12px 0; color: var(--textColorSecondary); }
      .helm-diff-find { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; }
      .helm-diff-find input { background: var(--contentColor); color: var(--textColorPrimary); border: 1px solid var(--borderColor); padding: 5px 8px; }
      .helm-diff-scroll { position: relative; }
      .helm-code-view-horizontal { scrollbar-width: none; }
      .helm-code-view-horizontal::-webkit-scrollbar { height: 0; }
      .helm-diff-horizontal-footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); flex-shrink: 0; min-width: 0; }
      .helm-diff-horizontal-scroll { min-width: 0; overflow-x: auto; overflow-y: hidden; }
      .helm-diff-horizontal-scroll:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
      .helm-diff-summary .Checkbox { position: relative; }
      .helm-diff-summary .Checkbox input[type=checkbox] { display: block; position: absolute; left: 0; top: 50%; width: 14px; height: 14px; transform: translateY(-50%); opacity: 0; margin: 0; z-index: 1; }
      .helm-diff-summary .Checkbox input:focus-visible ~ .box { outline: 2px solid var(--primary); outline-offset: 3px; }
      .helm-diff-summary .helm-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; color: var(--textColorSecondary); border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
      .helm-diff-summary .helm-icon-button:hover { color: var(--textColorPrimary); background: var(--contentColor); }
      .helm-diff-summary .helm-icon-button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      .helm-diff-summary strong { color: var(--textColorPrimary); }
      .helm-diff-added { color: var(--colorOk, var(--primary)); }
      .helm-diff-removed { color: var(--colorError, var(--textColorPrimary)); }
      .helm-diff-scroll { max-height: 52vh; overflow-y: auto; border: 1px solid var(--borderColor); border-radius: 6px; }
      .helm-diff-panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .helm-diff-pane { min-width: 0; overflow: hidden; }
      .helm-diff-pane + .helm-diff-pane { border-left: 1px solid var(--borderColor); }
      .helm-diff-headers h4 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; background: var(--contentColor); border-bottom: 1px solid var(--borderColor); font-size: 12px; overflow-wrap: anywhere; }
      .helm-diff-headers { position: sticky; top: 0; z-index: 2; align-items: stretch; background: var(--contentColor); }
      .helm-diff-headers h4 { min-width: 0; }
      .helm-diff-headers h4 + h4 { border-left: 1px solid var(--borderColor); }
      .helm-diff-gap { padding: 7px 12px; text-align: center; background: var(--contentColor); color: var(--textColorSecondary); border-block: 1px solid var(--borderColor); }
      .helm-diff-match { outline: 1px solid var(--primary); outline-offset: -1px; }
      .helm-diff-empty { background: var(--contentColor); }
      .helm-diff-line-added { background: color-mix(in srgb, var(--colorOk, var(--primary)) 16%, transparent); }
      .helm-diff-line-removed { background: color-mix(in srgb, var(--colorError, var(--textColorPrimary)) 16%, transparent); }
      .helm-diff-gutter-added { border-left: 3px solid var(--colorOk, var(--primary)); }
      .helm-diff-gutter-removed { border-left: 3px solid var(--colorError, var(--textColorPrimary)); }
    `}</style>
      <div className="helm-diff-summary" role="status">
        {diff.available ? (
          unchanged ? (
            <strong>No changes between these revisions</strong>
          ) : (
            <>
              <strong>Document changes</strong>
              <span className="helm-diff-added">+ {diff.added} added lines</span>
              <span className="helm-diff-removed">− {diff.removed} removed lines</span>
            </>
          )
        ) : (
          <span>{diff.reason}</span>
        )}
        {diff.available && !blocks && (
          <span>Aligned comparison exceeds the display limit. Documents are shown without alignment.</span>
        )}
        {displayLimited && <span>Document display exceeds the safe rendering limit.</span>}
        {previews && (previews.before.limited || previews.after.limited) && (
          <>
            <span>
              Only the first 1000 lines and 262144 characters of each original document are previewed. Copy a full
              document to read all of it.
            </span>
            <NativeTooltip title="Copy full source document">
              <button
                type="button"
                className="helm-icon-button"
                aria-label="Copy full source document"
                onClick={() => copyDocument(true)}
              >
                <Icon material="content_copy" size={18} />
              </button>
            </NativeTooltip>
            <NativeTooltip title="Copy full target document">
              <button
                type="button"
                className="helm-icon-button"
                aria-label="Copy full target document"
                onClick={() => copyDocument(false)}
              >
                <Icon material="content_copy" size={18} />
              </button>
            </NativeTooltip>
            {copyStatus && <span>{copyStatus}</span>}
          </>
        )}
        {diff.available && blocks && <Checkbox label="Show full documents" value={full} onChange={setFull} />}
        {(!unchanged || full || fallback) && <small>Both panes share vertical scrolling</small>}
      </div>
      {findOpen && (
        <div className="helm-diff-find" role="search" aria-label="Find in comparison">
          <input
            ref={findRef}
            aria-label="Find in both documents"
            placeholder="Find in both documents"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setMatchIndex(
                  (index) => (index + (event.shiftKey ? -1 : 1) + search.matches.length) % (search.matches.length || 1),
                );
              }
            }}
          />
          <span role="status">
            {!search.available
              ? "Document find exceeds the 2 MiB per-document limit"
              : query
                ? `${search.count} matches${match ? ` · ${match.source === "before" ? "Source" : "Target"} line ${match.line}, column ${match.column}` : ""}`
                : "Search both original documents"}
          </span>
          {search.count > search.matches.length && <span>Navigation is limited to the first 1000 matches</span>}
          <Button
            label="Previous match"
            disabled={!match}
            onClick={() => setMatchIndex((index) => (index - 1 + search.matches.length) % search.matches.length)}
          />
          <Button
            label="Next match"
            disabled={!match}
            onClick={() => setMatchIndex((index) => (index + 1) % search.matches.length)}
          />
          <Button label="Close find" onClick={() => setFindOpen(false)} />
          {match && (fallback || !matchVisible) && (
            <div style={{ width: "100%" }}>
              <strong>
                {match.source === "before" ? "Source" : "Target"} match at original line {match.line}
              </strong>
              <HelmCodeView
                value={(match.source === "before" ? before : after)
                  .split("\n")
                  .slice(Math.max(0, match.line - 4), match.line + 3)
                  .join("\n")}
                language={language}
                startLine={Math.max(1, match.line - 3)}
                ariaLabel="Matching original document excerpt"
              />
            </div>
          )}
        </div>
      )}
      {(!unchanged || full || fallback) && (
        <div ref={viewportRef} className="helm-diff-scroll" tabIndex={0} aria-label="Comparison documents">
          <div className="helm-diff-panes helm-diff-headers">
            <h4>{beforeLabel}</h4>
            <h4>{afterLabel}</h4>
          </div>
          {fallback ? (
            <div className="helm-diff-panes">
              <div className="helm-diff-pane">
                <HelmCodeView
                  value={previews!.before.value}
                  language={language}
                  ariaLabel={label(beforeLabel, true)}
                  expanded
                  style={{ height: fallbackHeight, minHeight: 0 }}
                  horizontal={horizontal}
                />
              </div>
              <div className="helm-diff-pane">
                <HelmCodeView
                  value={previews!.after.value}
                  language={language}
                  ariaLabel={label(afterLabel, false)}
                  expanded
                  style={{ height: fallbackHeight, minHeight: 0 }}
                  horizontal={horizontal}
                />
              </div>
            </div>
          ) : (
            blocks.map((block, index) => {
              if (block.kind === "gap")
                return (
                  <div className="helm-diff-gap" key={index}>
                    {block.count} unchanged lines hidden
                  </div>
                );
              const height = Math.max(block.before.length, block.after.length) * 18 + 14;
              return (
                <div
                  className={`helm-diff-panes${findOpen && match && (match.source === "before" ? match.line >= block.beforeStart && match.line < block.beforeStart + block.before.length : match.line >= block.afterStart && match.line < block.afterStart + block.after.length) ? " helm-diff-match" : ""}`}
                  key={index}
                  data-helm-before-start={block.beforeStart}
                  data-helm-before-count={block.before.length}
                  data-helm-after-start={block.afterStart}
                  data-helm-after-count={block.after.length}
                >
                  <div className="helm-diff-pane">
                    {renderCode(block.before, block.beforeStart, true, block.changed, height)}
                  </div>
                  <div className="helm-diff-pane">
                    {renderCode(block.after, block.afterStart, false, block.changed, height)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
      {(!unchanged || full || fallback) && (
        <div className="helm-diff-horizontal-footer">
          <HelmHorizontalBar horizontal={horizontal} source />
          <HelmHorizontalBar horizontal={horizontal} source={false} />
        </div>
      )}
    </section>
  );
}
