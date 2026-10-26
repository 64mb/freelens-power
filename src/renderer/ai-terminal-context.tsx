import { Renderer } from "@freelensapp/extensions";
import { useEffect, useState } from "react";
import { type AiTerminalSnapshot, sanitizeAiTerminalSnapshot } from "../common/ai-terminal-context";
import { formatDateTime } from "../common/date-time";
import { AiAttachmentCard } from "./ai-attachment-card";
import { AiIcon } from "./ai-icon";
import { NativeTooltip } from "./native-tooltip";

type TerminalBuffer = {
  length: number;
  baseY: number;
  cursorY: number;
  getLine(index: number): { isWrapped?: boolean; translateToString(trimRight?: boolean): string } | undefined;
};

export function activeAiTerminal(clusterId?: string): string | undefined {
  if (!clusterId || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId) return;
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
    const id = element.dataset.testid?.slice(prefix.length);
    if (!visible || !id || !Renderer.Component.terminalStore.isConnected(id)) continue;
    const api = Renderer.Component.terminalStore.getTerminalApi(id);
    if (api?.isReady && api.isConnected()) return id;
  }
  return;
}

export function captureAiTerminal(clusterId?: string, expectedId?: string): AiTerminalSnapshot | undefined {
  const id = activeAiTerminal(clusterId);
  if (!id || (expectedId && id !== expectedId)) return;
  try {
    // [xterm] is a guarded host implementation detail with no public buffer accessor
    const terminal = Renderer.Component.terminalStore.getTerminal(id) as unknown as
      | {
          xterm?: { buffer?: { active?: TerminalBuffer } };
        }
      | undefined;
    const buffer = terminal?.xterm?.buffer?.active;
    if (!buffer || !Number.isSafeInteger(buffer.length) || buffer.length > 10_000 || buffer.length < 0) return;
    const end = buffer.length;
    if (!Number.isSafeInteger(end) || end < 0) return;
    const logical: string[] = [];
    let characters = 0;
    for (let index = 0; index < end; index++) {
      const line = buffer.getLine(index);
      if (!line || (index === 0 && line.isWrapped)) return;
      const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
      characters += text.length + 1;
      if (characters > 1_000_000) return;
      if (line.isWrapped && logical.length) logical[logical.length - 1] += text;
      else logical.push(text);
    }
    if (activeAiTerminal(clusterId) !== id) return;
    return sanitizeAiTerminalSnapshot({ text: logical.join("\n"), capturedAt: new Date().toISOString() });
  } catch {
    return;
  }
}

export interface AiTerminalAttachment {
  clusterId: string;
  terminalId: string;
}

export function AiTerminalContext({
  clusterId,
  attachment,
  onChange,
  disabled,
}: {
  clusterId?: string;
  attachment?: AiTerminalAttachment;
  onChange(value: AiTerminalAttachment | undefined, reason?: "manual" | "unavailable"): void;
  disabled: boolean;
}) {
  const [terminalId, setTerminalId] = useState(() => activeAiTerminal(clusterId));
  const [preview, setPreview] = useState<AiTerminalSnapshot>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const update = () => setTerminalId(activeAiTerminal(clusterId));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [clusterId]);
  const attached = Boolean(attachment && attachment.clusterId === clusterId && attachment.terminalId === terminalId);
  useEffect(() => {
    if (!attached) {
      if (attachment) onChange(undefined, "unavailable");
      setPreview(undefined);
      return;
    }
    let stopped = false;
    let scheduled: number | undefined;
    let polling: number | undefined;
    let subscription: { dispose(): void } | undefined;
    const stop = () => {
      stopped = true;
      window.clearTimeout(scheduled);
      window.clearInterval(polling);
      subscription?.dispose();
      subscription = undefined;
    };
    const update = () => {
      if (stopped) return;
      scheduled = undefined;
      const snapshot = captureAiTerminal(clusterId, attachment?.terminalId);
      setUnavailable(!snapshot);
      if (!snapshot) {
        setPreview(undefined);
        if (activeAiTerminal(clusterId) !== attachment?.terminalId) {
          stop();
          onChange(undefined, "unavailable");
        }
        return;
      }
      setPreview((previous) =>
        previous?.text === snapshot.text && previous.truncated === snapshot.truncated ? previous : snapshot,
      );
    };
    update();
    if (stopped) return stop;
    try {
      const terminal = Renderer.Component.terminalStore.getTerminal(attachment!.terminalId) as unknown as
        | {
            xterm?: { onWriteParsed?: (listener: () => void) => { dispose(): void } };
          }
        | undefined;
      subscription = terminal?.xterm?.onWriteParsed?.(() => {
        if (!stopped && scheduled === undefined) scheduled = window.setTimeout(update, 250);
      });
    } catch {}
    if (!subscription) polling = window.setInterval(update, 1000);
    return stop;
  }, [attached, attachment, clusterId, onChange]);
  const tooltip = attached
    ? "Detach terminal output from this question"
    : terminalId
      ? "Attach terminal output to this question"
      : "Open a connected terminal in this cluster";
  return (
    <div className="power-ai-terminal-context" style={{ fontSize: 11 }}>
      <style>{`.power-ai-terminal-trigger{position:absolute;top:8px;right:8px;display:inline-flex}`}</style>
      <span className="power-ai-terminal-trigger">
        <NativeTooltip title={tooltip}>
          <button
            type="button"
            aria-label="Attach terminal output"
            aria-pressed={attached}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              minHeight: 26,
              padding: 0,
              color: "var(--textColorSecondary)",
              borderColor: "var(--borderFaintColor)",
              background: attached ? "color-mix(in srgb, var(--textColorPrimary) 8%, transparent)" : "transparent",
            }}
            disabled={disabled || !terminalId}
            onClick={() => {
              if (attached) {
                onChange(undefined);
                setPreview(undefined);
                return;
              }
              const snapshot = captureAiTerminal(clusterId, terminalId);
              setUnavailable(!snapshot);
              if (!snapshot || !clusterId || !terminalId) return;
              setPreview(snapshot);
              onChange({ clusterId, terminalId });
            }}
          >
            <AiIcon material="terminal" size={16} />
          </button>
        </NativeTooltip>
      </span>
      {attached && preview && (
        <AiAttachmentCard
          kind="terminal"
          title={`Terminal · ${preview.text.split("\n").length} rows${preview.truncated ? " · truncated" : ""}`}
          text={preview.text}
          ariaLabel="Attached terminal output"
          removeLabel="Remove terminal output"
          onRemove={() => onChange(undefined)}
          caption={`Preview captured ${formatDateTime(preview.capturedAt)} · captured again when sent · up to 300 rows / 32 KiB · Common credentials masked. Review before sending. The sent attachment is stored in chat history.`}
        />
      )}
      {unavailable && (
        <div role="status" style={{ padding: "4px 16px 8px" }}>
          Terminal output is unavailable or exceeds the safe capture limit
        </div>
      )}
    </div>
  );
}
