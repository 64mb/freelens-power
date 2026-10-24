import type { ReactNode } from "react";

export function LogJson({ text }: { text: string }) {
  const tokens: ReactNode[] = [];
  const pattern = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    tokens.push(text.slice(cursor, start));
    const value = match[0];
    const key = value.startsWith('"') && value.endsWith(":");
    const kind = key
      ? "key"
      : value.startsWith('"')
        ? "string"
        : /^(true|false|null)$/.test(value)
          ? "literal"
          : "number";
    tokens.push(
      <span key={start} data-token={kind}>
        {key ? value.slice(0, -1) : value}
      </span>,
    );
    if (key) tokens.push(":");
    cursor = start + value.length;
  }
  tokens.push(text.slice(cursor));
  return <pre className="power-log-json">{tokens}</pre>;
}
