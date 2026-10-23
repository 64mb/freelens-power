// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  contextId: "context-a",
  api: {} as object | undefined,
  store: {} as object | undefined,
  open: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-a" } }) } },
    K8sApi: { apiManager: { getApi: () => state.api, getStore: () => state.store } },
    Navigation: { showDetails: state.open },
  },
}));
vi.mock("./resource-search-client", () => ({
  createResourceSearchTransport: () => ({ get: state.get }),
  searchContextId: () => state.contextId,
}));

import { closeSearchResourceFallback, openSearchResource } from "./resource-search-routing";

const resource = {
  group: "example.test",
  version: "v1",
  resource: "widgets",
  kind: "Widget",
  name: "sample",
  namespace: "default",
  labels: {},
  path: "/apis/example.test/v1/namespaces/default/widgets/sample",
};
afterEach(() => {
  closeSearchResourceFallback();
  document.body.innerHTML = "";
  state.api = {};
  state.contextId = "context-a";
  state.store = {};
  vi.clearAllMocks();
});
it("defers native opening until the triggering click has finished dispatching", async () => {
  let outsideClick = false;
  const listener = () => {
    outsideClick = true;
  };
  state.open.mockImplementation(() => document.addEventListener("click", listener, { once: true }));
  const button = document.createElement("button");
  document.body.append(button);
  let opening: Promise<void> | undefined;
  button.onclick = () => {
    opening = openSearchResource(resource);
  };
  button.click();
  expect(state.open).not.toHaveBeenCalled();
  await opening;
  expect(state.open).toHaveBeenCalledWith(resource.path);
  expect(outsideClick).toBe(false);
  document.removeEventListener("click", listener);
});
it("opens a safe metadata fallback without CRD listing permissions or exposing payloads", async () => {
  state.api = undefined;
  state.get.mockResolvedValue({
    metadata: { name: "sample", namespace: "default", labels: { app: "demo" }, annotations: { private: "sensitive" } },
    spec: { private: "sensitive" },
  });
  HTMLDialogElement.prototype.showModal = vi.fn();
  await openSearchResource(resource);
  expect(state.get).toHaveBeenCalledWith(
    resource.path,
    undefined,
    expect.objectContaining({ Accept: expect.stringContaining("PartialObjectMetadata") }),
  );
  expect(document.body.textContent).toContain("sample");
  expect(document.body.textContent).not.toContain("sensitive");
  expect(state.open).not.toHaveBeenCalled();
});

it.each(["team+ops", "system:discovery"])("opens native raw self-links for encoded RBAC name %s", async (name) => {
  const path = `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`;
  await openSearchResource({ ...resource, namespace: undefined, name, path });
  expect(state.open).toHaveBeenCalledWith(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`);
  expect(state.get).not.toHaveBeenCalled();
});

it("keeps URL delimiters encoded when opening generic metadata", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  state.get.mockResolvedValue({ metadata: { name: "team#ops", labels: {} } });
  const path = "/apis/rbac.authorization.k8s.io/v1/clusterroles/team%23ops";
  await openSearchResource({ ...resource, namespace: undefined, name: "team#ops", path });
  expect(state.open).not.toHaveBeenCalled();
  expect(state.get).toHaveBeenCalledWith(path, undefined, expect.any(Object));
});

it("ignores a late generic reply after extension cleanup closes pending details", async () => {
  state.api = undefined;
  let resolve!: (value: unknown) => void;
  state.get.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const opening = openSearchResource(resource);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  closeSearchResourceFallback();
  resolve({ metadata: { name: "sample", namespace: "default" } });
  await opening;
  expect(document.querySelector("dialog")).toBeNull();
});
it("ignores a late generic reply after credentials/context changed for the same cluster", async () => {
  state.api = undefined;
  let resolve!: (value: unknown) => void;
  state.get.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const opening = openSearchResource(resource);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  state.contextId = "context-b";
  resolve({ metadata: { name: "sample", namespace: "default" } });
  await opening;
  expect(document.querySelector("dialog")).toBeNull();
});
it("cancels a deferred native opening when extension cleanup happens before the next turn", async () => {
  const opening = openSearchResource(resource);
  closeSearchResourceFallback();
  await opening;
  expect(state.open).not.toHaveBeenCalled();
});
