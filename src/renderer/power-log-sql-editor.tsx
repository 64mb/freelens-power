import { useLayoutEffect, useMemo, useRef } from "react";

import type { MouseEvent } from "react";

type SqlToken = { text: string; kind?: "keyword" | "function" | "string" | "identifier" | "number" | "comment" };
const keywords = new Set(
  "SELECT FROM WHERE AS AND OR NOT NULL IS IN LIKE GLOB BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT ALL JOIN LEFT RIGHT INNER OUTER CROSS FULL ON USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION INTERSECT EXCEPT WITH RECURSIVE OVER PARTITION ROWS RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ROW NULLS FIRST LAST TRUE FALSE COLLATE CAST FILTER WINDOW VALUES EXPLAIN QUERY PLAN".split(
    " ",
  ),
);
const lexeme =
  /--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|\b(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)(?![\w])|\b[a-z_]\w*\b/gi;

function isFunction(source: string, offset: number): boolean {
  while (offset < source.length && /\s/.test(source[offset])) offset++;
  return source[offset] === "(";
}

export function tokenizeSql(value: string): SqlToken[] {
  const source = value.slice(0, 65536);
  const tokens: SqlToken[] = [];
  let offset = 0;
  lexeme.lastIndex = 0;
  for (let match = lexeme.exec(source); match && tokens.length < 9998; match = lexeme.exec(source)) {
    if (match.index > offset) tokens.push({ text: source.slice(offset, match.index) });
    const text = match[0];
    const kind =
      text.startsWith("--") || text.startsWith("/*")
        ? "comment"
        : text.startsWith("'")
          ? "string"
          : text.startsWith('"') || text.startsWith("`") || text.startsWith("[")
            ? "identifier"
            : /^\d/.test(text)
              ? "number"
              : keywords.has(text.toUpperCase())
                ? "keyword"
                : isFunction(source, match.index + text.length)
                  ? "function"
                  : undefined;
    tokens.push({ text, kind });
    offset = match.index + text.length;
  }
  if (offset < value.length) tokens.push({ text: value.slice(offset) });
  return tokens;
}

const styles = `
.power-logs .power-logs-sql-editor{position:relative;box-sizing:border-box;width:100%;height:56px;min-height:48px;max-height:var(--sql-content-max-height,120px);flex-shrink:0;resize:vertical;overflow:hidden;border:1px solid var(--borderColor);border-radius:4px;background:var(--inputControlBackground,var(--contentColor));--sql-string:#e6a28c;--sql-number:#98c78e;--sql-function:#81b9e6;--sql-identifier:var(--textColorPrimary)}
.power-logs .power-logs-sql-editor::-webkit-resizer{border:0;background:linear-gradient(135deg,transparent 45%,var(--borderColor) 46% 53%,transparent 54% 70%,var(--borderColor) 71% 78%,transparent 79%) center/10px 10px no-repeat}
.theme-light .power-logs-sql-editor{--sql-string:#9e2b1a;--sql-number:#17642d;--sql-function:#005a9e;--sql-identifier:#684c9b}
.power-logs .power-logs-sql-editor>textarea,.power-logs .power-logs-sql-editor>pre{position:absolute;inset:0;box-sizing:border-box;width:100%;height:100%;min-height:0;max-height:none;margin:0;padding:4px 8px;border:0;border-radius:0;font:12px/1.6 var(--font-monospace,monospace);letter-spacing:normal;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;overflow:auto;scrollbar-gutter:stable;resize:none}
.power-logs .power-logs-sql-editor>pre{pointer-events:none;color:var(--textColorPrimary);background:transparent;user-select:none}
.power-logs .power-logs-sql-editor>textarea{color:transparent;background:transparent;caret-color:var(--textColorPrimary);-webkit-text-fill-color:transparent}
.power-logs .power-logs-sql-editor>textarea::selection{background:rgba(100,150,240,.35);color:transparent}
.power-logs-sql-editor [data-sql-token=keyword]{color:var(--primary)}
.power-logs-sql-editor [data-sql-token=function]{color:var(--sql-function)}
.power-logs-sql-editor [data-sql-token=string]{color:var(--sql-string)}
.power-logs-sql-editor [data-sql-token=identifier]{color:var(--sql-identifier)}
.power-logs-sql-editor [data-sql-token=number]{color:var(--sql-number)}
.power-logs-sql-editor [data-sql-token=comment]{color:var(--textColorSecondary)}
`;

export function SqlEditor({
  id,
  value,
  onChange,
  fitVersion = 0,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  fitVersion?: number;
}) {
  const fitted = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenizeSql(value), [value]);
  const syncScroll = () => {
    if (!textarea.current || !highlight.current) return;
    highlight.current.scrollTop = textarea.current.scrollTop;
    highlight.current.scrollLeft = textarea.current.scrollLeft;
  };
  useLayoutEffect(syncScroll, [value]);
  useLayoutEffect(() => {
    const pre = highlight.current;
    const editor = pre?.parentElement;
    if (!pre || !editor) return;
    const measure = () => {
      pre.style.height = "auto";
      pre.style.bottom = "auto";
      const height = pre.getBoundingClientRect().height;
      pre.style.removeProperty("height");
      pre.style.removeProperty("bottom");
      editor.style.setProperty("--sql-content-max-height", `${Math.max(120, Math.min(240, Math.ceil(height) + 10))}px`);
      if (fitVersion !== fitted.current) {
        editor.style.height = `${Math.max(48, Math.min(240, Math.ceil(height) + 2))}px`;
        fitted.current = fitVersion;
      }
      syncScroll();
    };
    measure();
    let width = editor.clientWidth;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (editor.clientWidth === width) return;
      width = editor.clientWidth;
      measure();
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [value, fitVersion]);
  const selectQuery = (event: MouseEvent<HTMLTextAreaElement>) => {
    if (event.detail < 3) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.focus();
    event.currentTarget.select();
  };
  return (
    <div className="power-logs-sql-editor">
      <style>{styles}</style>
      <pre ref={highlight} aria-hidden="true">
        {tokens.map((token, index) => (
          <span key={index} data-sql-token={token.kind}>
            {token.text}
          </span>
        ))}
        {value.endsWith("\n") && " "}
      </pre>
      <textarea
        ref={textarea}
        id={id}
        value={value}
        maxLength={65536}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value.slice(0, 65536))}
        onScroll={syncScroll}
        onMouseDown={selectQuery}
        onClick={selectQuery}
      />
    </div>
  );
}
