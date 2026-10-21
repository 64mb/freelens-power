import { Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import { type AiResourceReference, referencedAiResources, validAiResourceReference } from "../common/ai-extras";
import { AiIcon } from "./ai-icon";

import type { AiChatRequest } from "../common/ai";

export function AiContextPreview({ context }: { context: AiChatRequest["context"] }) {
  return (
    <details className="power-ai-context-preview" style={{ padding: "8px 16px", fontSize: 11 }}>
      <summary title="Show the screen and resource metadata attached to your next message">Attached context</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 160, overflowY: "auto" }}>
        {JSON.stringify(context, null, 2)}
      </pre>
      <p>Screen and resource metadata only. Resource reads happen after sending.</p>
    </details>
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
          <button
            type="button"
            key={JSON.stringify(reference)}
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
            title={`Open ${reference.kind}/${reference.name} details · ${reference.namespace ?? "cluster scoped"}`}
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
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
