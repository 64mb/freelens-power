import { Renderer } from "@freelensapp/extensions";
import { useState } from "react";
import { type AiResourceReference, normalizeAiReferences, validAiResourceReference } from "../common/ai-extras";

import type { AiChatRequest } from "../common/ai";

export function AiContextPreview({ context }: { context: AiChatRequest["context"] }) {
  return (
    <details className="power-ai-context-preview" style={{ padding: "8px 16px", fontSize: 11 }}>
      <summary>Attached context</summary>
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
  Renderer.Navigation.showDetails(api.getUrl({ name: reference.name, namespace: reference.namespace }));
}

export function AiResourceReferences({ clusterId, references }: { clusterId: string; references: unknown }) {
  const [error, setError] = useState("");
  const items = normalizeAiReferences(references);
  if (!items.length) return null;
  return (
    <div className="power-ai-resource-references" style={{ marginTop: 12 }}>
      <span style={{ fontSize: 11, color: "var(--textColorSecondary)" }}>Related resources</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {items.map((reference) => (
          <button
            type="button"
            key={JSON.stringify(reference)}
            title={`${reference.kind} · ${reference.namespace ?? "cluster scoped"}`}
            onClick={() => {
              setError("");
              void openAiResourceReference(clusterId, reference).catch(() =>
                setError("Unable to open this resource. Check the selected cluster and your access."),
              );
            }}
          >
            {reference.kind}/{reference.name}
            {reference.namespace ? ` · ${reference.namespace}` : ""}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
