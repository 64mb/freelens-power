import { useMemo } from "react";
import { formatAiAttachmentText } from "../common/ai-attachments";
import { AiIcon } from "./ai-icon";
import { NativeTooltip } from "./native-tooltip";
import { LogJson } from "./power-log-json";

export interface AiAttachmentCardProps {
  kind: "resource" | "evidence" | "terminal";
  title: string;
  text: string;
  onRemove?: () => void;
  caption?: string;
  source?: string;
  ariaLabel?: string;
  removeLabel?: string;
}

export function AiAttachmentCard({
  kind,
  title,
  text,
  onRemove,
  caption,
  source,
  ariaLabel,
  removeLabel = "Remove attachment",
}: AiAttachmentCardProps) {
  const formatted = useMemo(() => formatAiAttachmentText(text, 64000), [text]);
  const structured = useMemo(() => {
    if (/^\s*[\[{]/.test(text)) return true;
    try {
      JSON.parse(text);
      return true;
    } catch {
      const lines = text.split("\n").filter((line) => line.trim());
      if (lines.length < 2) return false;
      return lines.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
    }
  }, [text]);
  const limited = useMemo(() => {
    try {
      return JSON.parse(text)?.attachmentLimited === true;
    } catch {
      return false;
    }
  }, [text]);
  const icon =
    kind === "terminal"
      ? "terminal"
      : kind === "resource"
        ? "description"
        : source === "relationships"
          ? "account_tree"
          : source === "logs"
            ? "subject"
            : "insights";
  return (
    <div className={`power-ai-attachment-card power-ai-attachment-${kind}`} aria-label={ariaLabel}>
      <AiIcon material={icon} size={14} />
      <details>
        <NativeTooltip title="Review attached content">
          <summary>{title}</summary>
        </NativeTooltip>
        <div
          className="power-ai-attachment-content"
          style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {structured ? (
            <LogJson text={formatted} fieldsEnabled={false} />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{formatted}</pre>
          )}
        </div>
        {(caption || limited) && (
          <p className="power-ai-attachment-caption">
            {limited ? "Partial snapshot · some content omitted. " : ""}
            {caption}
          </p>
        )}
      </details>
      {onRemove && (
        <NativeTooltip title={removeLabel}>
          <button type="button" className="power-ai-remove-context" aria-label={removeLabel} onClick={onRemove}>
            <AiIcon material="close" size={14} />
          </button>
        </NativeTooltip>
      )}
    </div>
  );
}
