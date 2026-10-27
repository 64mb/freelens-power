import { Renderer } from "@freelensapp/extensions";
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
import { compareHelmLines, type HelmLineRange } from "../common/helm-diff";

const { MonacoEditor } = Renderer.Component;
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
};

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
      className={`helm-code-view ${className}`}
      style={{
        height: `min(52vh, ${Math.max(readOnly ? 140 : 240, value.split("\n", 30).length * 18 + 28)}px)`,
        minHeight: readOnly ? 140 : 240,
        minWidth: 0,
        overflow: "hidden",
        ...style,
      }}
    >
      <MonacoEditor
        id={`${identity}-${ready ? "document" : "initial"}`}
        value={value}
        language={language}
        readOnly={readOnly}
        onChange={readOnly ? undefined : onChange}
        onModelChange={onModelChange}
        style={{ height: "100%", width: "100%" }}
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
          lineNumbers: "on",
          wordWrap: "off",
          fontSize: 12,
          padding: { top: 12, bottom: 12 },
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
  return (
    <section className="helm-revision-diff" aria-label="Revision comparison">
      <style>{`
      .helm-revision-diff { min-width: 0; }
      .helm-diff-summary { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 12px 0; color: var(--textColorSecondary); }
      .helm-diff-summary strong { color: var(--textColorPrimary); }
      .helm-diff-added { color: var(--colorSuccess, var(--primary)); }
      .helm-diff-removed { color: var(--colorError, var(--textColorPrimary)); }
      .helm-diff-panes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .helm-diff-pane { min-width: 0; border: 1px solid var(--borderColor); border-radius: 6px; overflow: hidden; }
      .helm-diff-pane h4 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; background: var(--contentColor); border-bottom: 1px solid var(--borderColor); font-size: 12px; overflow-wrap: anywhere; }
      .helm-diff-line-added { background: color-mix(in srgb, var(--colorSuccess, var(--primary)) 16%, transparent); }
      .helm-diff-line-removed { background: color-mix(in srgb, var(--colorError, var(--textColorPrimary)) 16%, transparent); }
      .helm-diff-gutter-added { border-left: 3px solid var(--colorSuccess, var(--primary)); }
      .helm-diff-gutter-removed { border-left: 3px solid var(--colorError, var(--textColorPrimary)); }
      @media (max-width: 900px) { .helm-diff-panes { grid-template-columns: minmax(0, 1fr); } }
    `}</style>
      <div className="helm-diff-summary" role="status">
        {diff.available ? (
          diff.added || diff.removed ? (
            <>
              <strong>Document changes</strong>
              <span className="helm-diff-added">+ {diff.added} added lines</span>
              <span className="helm-diff-removed">− {diff.removed} removed lines</span>
            </>
          ) : (
            <strong>No changes between these revisions</strong>
          )
        ) : (
          <span>{diff.reason}</span>
        )}
        <small>Panes scroll independently</small>
      </div>
      <div className="helm-diff-panes">
        <div className="helm-diff-pane">
          <h4>{beforeLabel}</h4>
          <HelmCodeView
            value={before}
            language={language}
            ariaLabel={typeof beforeLabel === "string" ? beforeLabel : "Comparison source document"}
            changeKind="removed"
            changeRanges={diff.available ? diff.beforeRanges : undefined}
          />
        </div>
        <div className="helm-diff-pane">
          <h4>{afterLabel}</h4>
          <HelmCodeView
            value={after}
            language={language}
            ariaLabel={typeof afterLabel === "string" ? afterLabel : "Comparison target document"}
            changeKind="added"
            changeRanges={diff.available ? diff.afterRanges : undefined}
          />
        </div>
      </div>
    </section>
  );
}
