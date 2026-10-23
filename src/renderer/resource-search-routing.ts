import { Renderer } from "@freelensapp/extensions";
import { createResourceSearchTransport, searchContextId } from "./resource-search-client";
import { projectMetadataPage, searchErrorStatus } from "./resource-search-discovery";

import type { SearchDocument } from "../common/resource-search";

let fallback: HTMLDialogElement | undefined;
let openingEpoch = 0;
export function closeSearchResourceFallback() {
  openingEpoch++;
  fallback?.remove();
  fallback = undefined;
}
export async function openSearchResource(resource: SearchDocument): Promise<void> {
  closeSearchResourceFallback();
  const epoch = openingEpoch;
  const contextId = searchContextId();
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  if (!clusterId) throw new Error("No active cluster");
  const valid = () =>
    epoch === openingEpoch &&
    Renderer.Catalog.activeCluster.get()?.metadata.uid === clusterId &&
    searchContextId() === contextId;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  if (!valid()) return;
  const api = Renderer.K8sApi.apiManager.getApi(resource.path);
  if (api && Renderer.K8sApi.apiManager.getStore(api)) {
    await Renderer.Navigation.showDetails(resource.path);
    return;
  }
  const transport = createResourceSearchTransport(clusterId);
  let metadata: { metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, unknown> } };
  try {
    metadata = await transport.get(resource.path, undefined, {
      Accept: "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1",
    });
  } catch (error) {
    if (!valid()) return;
    if (searchErrorStatus(error) !== 406 || !resource.group) throw error;
    metadata = await transport.get(resource.path, undefined, { Accept: "application/json" });
  }
  if (!valid()) return;
  const safe = projectMetadataPage(
    { ...resource, namespaced: !!resource.namespace, aliases: [] },
    { items: [metadata] },
  )[0];
  if (!safe) throw new Error("Resource metadata unavailable");
  closeSearchResourceFallback();
  const dialog = document.createElement("dialog");
  fallback = dialog;
  dialog.setAttribute("aria-label", `${safe.kind} ${safe.name}`);
  dialog.style.cssText =
    "max-width:640px;width:80%;padding:24px;background:var(--mainBackground,#222);color:var(--textColorPrimary,#eee);border:1px solid var(--borderColor,#555);border-radius:8px";
  const title = document.createElement("h2");
  title.textContent = `${safe.kind}: ${safe.name}`;
  const description = document.createElement("p");
  description.textContent = "Resource metadata. A native detail view is unavailable for this API.";
  const fields = document.createElement("pre");
  fields.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
  fields.textContent = JSON.stringify(
    {
      apiVersion: [safe.group, safe.version].filter(Boolean).join("/"),
      kind: safe.kind,
      metadata: { name: safe.name, namespace: safe.namespace, uid: safe.uid, labels: safe.labels },
    },
    null,
    2,
  );
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.onclick = closeSearchResourceFallback;
  dialog.append(title, description, fields, close);
  dialog.addEventListener("close", closeSearchResourceFallback, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
