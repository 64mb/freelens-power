import { memo, type ReactNode } from "react";
import { messageTokens } from "./power-log-message-tokens";

export const LogMessage = memo(function LogMessage({ text }: { text: string }) {
  const tokens: ReactNode[] = [];
  let cursor = 0;
  for (const token of messageTokens(text)) {
    tokens.push(text.slice(cursor, token.start));
    tokens.push(
      <span key={token.start} data-log-token={token.kind} data-status-class={token.statusClass}>
        {text.slice(token.start, token.end)}
      </span>,
    );
    cursor = token.end;
  }
  tokens.push(text.slice(cursor));
  return <span className="power-log-message">{tokens}</span>;
});
