import { Renderer } from "@freelensapp/extensions";
import { clipboard } from "electron";
import { useEffect, useState } from "react";
import { formatIncidentSummary, type IncidentSummary } from "../common/incident-summary";
import { AiIcon } from "./ai-icon";
import { NativeTooltip } from "./native-tooltip";
export function IncidentCopyButton({ incident, clusterId }: { incident: IncidentSummary; clusterId?: string }) {
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return (
    <span className="incident-copy">
      <NativeTooltip title={feedback || "Copy incident summary"}>
        <button
          type="button"
          aria-label="Copy incident summary"
          onClick={() => {
            try {
              const activeCluster = Renderer.Catalog.activeCluster.get();
              if (clusterId && activeCluster?.metadata.uid !== clusterId) {
                setFeedback("Cluster changed. Return to this finding before copying");
                return;
              }
              clipboard.writeText(
                formatIncidentSummary({
                  ...incident,
                  ...(clusterId ? { clusterName: activeCluster?.metadata.name ?? clusterId } : {}),
                }),
              );
              setFeedback("Copied");
            } catch {
              setFeedback("Unable to copy incident summary");
            }
          }}
        >
          <AiIcon material={feedback === "Copied" ? "check" : "content_copy"} size={14} />
        </button>
      </NativeTooltip>
      {feedback && <span role="status">{feedback}</span>}
    </span>
  );
}
