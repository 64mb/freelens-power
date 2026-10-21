import { clipboard } from "electron";
import { useEffect, useState } from "react";
import { AiIcon } from "./ai-icon";

export function AiCopyAnswer({ text }: { text: string }) {
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 1600);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return (
    <button
      type="button"
      className="power-ai-copy-answer"
      aria-label="Copy answer"
      title={feedback || "Copy answer"}
      onClick={() => {
        try {
          clipboard.writeText(text);
          setFeedback("Copied");
        } catch {
          setFeedback("Unable to copy answer");
        }
      }}
    >
      <AiIcon material={feedback === "Copied" ? "check" : "content_copy"} size={14} />
    </button>
  );
}
