import { Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import { type AiResourceReference, referencedAiResources, validAiResourceReference } from "../common/ai-extras";
import { formatDateTime } from "../common/date-time";
import { AiAttachmentCard } from "./ai-attachment-card";
import { AiIcon } from "./ai-icon";
import { NativeTooltip } from "./native-tooltip";
import { LogJson } from "./power-log-json";

import type { AiChatRequest } from "../common/ai";
import type { AiAttachmentReceipt } from "../common/ai-attachments";
import type { DiagnosticFinding } from "./ai-diagnostic-handoff";

export function AiContextPreview({
  context,
  hideInspector = false,
  resource,
  onRemoveResource,
  finding,
  onRemoveFinding,
}: {
  context: AiChatRequest["context"];
  hideInspector?: boolean;
  resource?: AiChatRequest["context"]["resource"];
  onRemoveResource?: () => void;
  finding?: DiagnosticFinding;
  onRemoveFinding?: () => void;
}) {
  return (
    <div className="power-ai-context-preview">
      {resource && (
        <AiAttachmentCard
          kind="resource"
          title={`${resource.kind ?? "Resource"}/${resource.name ?? "selected"}`}
          text={JSON.stringify(resource, null, 2)}
          onRemove={onRemoveResource}
          ariaLabel="Attached resource"
          removeLabel="Remove attached resource"
          caption="Resource metadata · sent with your next message"
        />
      )}
      {finding && (
        <AiAttachmentCard
          kind="evidence"
          title={finding.title}
          text={finding.summary}
          source={finding.source}
          onRemove={onRemoveFinding}
          ariaLabel="Selected diagnostic finding"
          removeLabel="Remove diagnostic finding"
          caption="Selected snapshot · sent with your next message"
        />
      )}
      {!hideInspector && <AiContextInspector context={context} />}
    </div>
  );
}

export function AiContextInspector({ context }: { context: AiChatRequest["context"] }) {
  return (
    <details className="power-ai-context-inspector">
      <NativeTooltip title="Show the screen and resource metadata attached to your next message">
        <summary>What will be sent</summary>
      </NativeTooltip>
      <div className="power-ai-context-content">
        <LogJson text={JSON.stringify(context, null, 2)} fieldsEnabled={false} />
      </div>
      <p>Screen and resource metadata only. Resource reads happen after sending.</p>
    </details>
  );
}

export function AiAttachmentReceipts({ attachments }: { attachments?: AiAttachmentReceipt[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="power-ai-attachment-receipts" aria-label="Sent attachments">
      {attachments.map((attachment, index) => (
        <AiAttachmentCard
          key={index}
          kind={attachment.kind}
          title={attachment.title}
          text={attachment.text}
          source={attachment.source}
          caption={`Sent with this message${attachment.capturedAt ? ` · ${formatDateTime(attachment.capturedAt)}` : ""}`}
        />
      ))}
    </div>
  );
}

export async function openAiResourceReference(clusterId: string, reference: AiResourceReference): Promise<void> {
  if (!validAiResourceReference(reference) || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId)
    throw new Error("Select the original cluster to open this resource");
  const api = Renderer.K8sApi.apiManager.getApiByKind(reference.kind, reference.apiVersion);
  if (!api || api.isNamespaced !== Boolean(reference.namespace)) throw new Error("Resource details are unavailable");
  const resource = await api.get({ name: reference.name, namespace: reference.namespace });
  if (!resource || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId)
    throw new Error("Resource details are unavailable");
  await Renderer.Navigation.showDetails(api.getUrl({ name: reference.name, namespace: reference.namespace }));
}

export function AiResourceReferences({
  clusterId,
  references,
  text,
  onOpened,
}: {
  clusterId: string;
  references: unknown;
  text: string;
  onOpened?: () => void;
}) {
  const [error, setError] = useState("");
  const items = referencedAiResources(text, references);
  if (!items.length) return null;
  return (
    <div className="power-ai-resource-references" style={{ marginTop: 12 }}>
      <style>{`.power-ai-resource-references button.power-ai-resource-reference:hover { color: var(--primary); border-color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, var(--contentColor)); } .power-ai-resource-references button.power-ai-resource-reference:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }`}</style>
      <span style={{ fontSize: 11, color: "var(--textColorSecondary)" }}>Related resources</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {items.map((reference) => (
          <NativeTooltip
            key={JSON.stringify(reference)}
            title={`Open ${reference.kind}/${reference.name} details · ${reference.namespace ?? "cluster scoped"}`}
          >
            <button
              type="button"
              className="power-ai-resource-reference"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                maxWidth: "100%",
                minWidth: 0,
                padding: "4px 8px",
                fontSize: 12,
                lineHeight: 1.4,
                border: "1px solid var(--borderFaintColor)",
                borderRadius: 6,
              }}
              onClick={() => {
                setError("");
                void openAiResourceReference(clusterId, reference)
                  .then(onOpened)
                  .catch(() => setError("Unable to open this resource. Check the selected cluster and your access."));
              }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {reference.kind}/{reference.name}
                {reference.namespace ? ` · ${reference.namespace}` : ""}
              </span>
              <AiIcon material="arrow_forward" size={14} />
            </button>
          </NativeTooltip>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
