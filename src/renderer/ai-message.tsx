import { Renderer } from "@freelensapp/extensions";
import { clipboard, shell } from "electron";
import MarkdownIt, { type Token } from "markdown-it";
import { autorun } from "mobx";
import { createElement, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { AiIcon } from "./ai-icon";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const markdownTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "s",
  "a",
]);

function externalLink(value: string | number | null): string | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value);
    if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return;
}

function renderTokens(tokens: Token[]): ReactNode[] {
  type Container = { token?: Token; key: number; children: ReactNode[] };
  const stack: Container[] = [{ key: 0, children: [] }];
  const append = (node: ReactNode) => stack[stack.length - 1].children.push(node);
  tokens.forEach((token, index) => {
    if (token.nesting === 1) {
      stack.push({ token, key: index, children: [] });
      return;
    }
    if (token.nesting === -1) {
      if (stack.length === 1) return;
      const container = stack.pop()!;
      const opening = container.token!;
      const props: Record<string, unknown> = { key: container.key };
      let tag = markdownTags.has(opening.tag) && !opening.hidden ? opening.tag : Fragment;
      if (tag === "a") {
        const href = externalLink(opening.attrGet("href"));
        if (!href) tag = Fragment;
        else {
          props.href = href;
          props.title = opening.attrGet("title") ?? undefined;
          props.rel = "noopener noreferrer";
          props.target = "_blank";
          const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            if (event.type === "auxclick" && event.button !== 1) return;
            void shell.openExternal(href).catch(() => {});
          };
          props.onClick = open;
          props.onAuxClick = open;
        }
      }
      if (tag === "ol") {
        const start = Number(opening.attrGet("start"));
        if (Number.isSafeInteger(start) && start > 0) props.start = start;
      }
      if (tag === "th" || tag === "td") {
        const alignment = String(opening.attrGet("style") ?? "").match(/^text-align:(left|right|center)$/)?.[1];
        if (alignment) props.style = { textAlign: alignment };
      }
      append(createElement(tag, props, ...container.children));
      return;
    }
    switch (token.type) {
      case "inline":
        append(<Fragment key={index}>{renderTokens(token.children ?? [])}</Fragment>);
        break;
      case "code_inline":
        append(<code key={index}>{token.content}</code>);
        break;
      case "fence":
      case "code_block":
        append(<CodeBlock key={index} language={token.info.trim().split(/\s+/)[0]} text={token.content} />);
        break;
      case "hardbreak":
      case "softbreak":
        append(<br key={index} />);
        break;
      case "hr":
        append(<hr key={index} />);
        break;
      default:
        append(<Fragment key={index}>{token.content}</Fragment>);
    }
  });
  return stack[0].children;
}

export function terminalInsertText(text: string): string | undefined {
  const command = text.replace(/^[\r\n]+|[\r\n]+$/g, "");
  // surrounding line endings are formatting, embedded control characters must never reach the terminal
  if (!command.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(command)) return undefined;
  return command;
}

function visibleTerminalId(): string | undefined {
  const prefix = "dock-tab-content-for-";
  for (const element of document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)) {
    let visible = true;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        visible = false;
        break;
      }
    }
    if (!visible) continue;
    const id = element.dataset.testid?.slice(prefix.length);
    if (!id || !Renderer.Component.terminalStore.isConnected(id)) continue;
    const api = Renderer.Component.terminalStore.getTerminalApi(id);
    if (api?.isReady && api.isConnected()) return id;
  }
  return;
}

function useActiveTerminalId(): string | undefined {
  const [terminalId, setTerminalId] = useState<string>();
  useEffect(() => {
    let stop: (() => void) | undefined;
    const update = () => {
      stop?.();
      stop = autorun(() => setTerminalId(visibleTerminalId()));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "data-testid"],
    });
    return () => {
      observer.disconnect();
      stop?.();
    };
  }, []);
  return terminalId;
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [feedback, setFeedback] = useState("");
  const terminalId = useActiveTerminalId();
  const [inserting, setInserting] = useState(false);
  const shell = ["", "bash", "sh", "shell", "zsh", "console", "terminal"].includes(language.toLowerCase());
  const command = terminalInsertText(text);
  const insert = async () => {
    const activeTerminal = visibleTerminalId();
    if (!shell || !command || !activeTerminal || inserting) return;
    setInserting(true);
    try {
      await Renderer.Component.terminalStore.sendCommand(command, { enter: false, tabId: activeTerminal });
      setFeedback("Inserted into terminal. Review the command before running it.");
    } catch {
      setFeedback("Unable to insert into terminal.");
    } finally {
      setInserting(false);
    }
  };
  return (
    <div className="power-ai-code">
      <div className="power-ai-code-toolbar">
        <span>{language || "code"}</span>
        <div>
          <button
            type="button"
            aria-label="Copy code"
            onClick={() => {
              try {
                clipboard.writeText(text);
                setFeedback("Copied");
              } catch {
                setFeedback("Unable to copy code.");
              }
            }}
          >
            <AiIcon material="content_copy" size={14} /> Copy
          </button>
          {shell && terminalId && (
            <button
              type="button"
              aria-label="Insert into terminal"
              disabled={!command || !terminalId || inserting}
              title={
                !command
                  ? "Only a single line without control characters can be inserted"
                  : !terminalId
                    ? "Focus an open terminal tab to insert"
                    : "Insert without running"
              }
              onClick={() => void insert()}
            >
              <AiIcon material="terminal" size={14} /> Insert
            </button>
          )}
        </div>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
      {shell && !command && (
        <div className="power-ai-code-hint">Terminal insertion requires a single line without control characters.</div>
      )}
      <div role="status" className="power-ai-code-feedback">
        {feedback}
      </div>
    </div>
  );
}

export function AiMessageContent({ text }: { text: string }) {
  const content = useMemo(() => renderTokens(markdown.parse(text, {})), [text]);
  return <div className="power-ai-markdown">{content}</div>;
}
