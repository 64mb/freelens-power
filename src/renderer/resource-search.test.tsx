// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  id: "cluster-a",
  callback: () => {},
  preference: (_enabled: boolean) => {},
  searchEnabled: true,
  syncSignal: undefined as AbortSignal | undefined,
  coverage: (_status: unknown) => {},
  query: vi.fn(),
  clear: vi.fn(),
  open: vi.fn(),
  explain: vi.fn(),
  run: vi.fn(),
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: {
    getInstanceOrCreate: () => ({
      get resourceSearchEnabled() {
        return state.searchEnabled;
      },
    }),
  },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.id }, spec: {} }) } },
    K8sApi: Object.fromEntries(
      [
        "podsStore",
        "nodesStore",
        "deploymentStore",
        "statefulSetStore",
        "daemonSetStore",
        "replicaSetStore",
        "jobStore",
        "cronJobStore",
        "serviceStore",
        "ingressStore",
        "namespaceStore",
        "hpaStore",
      ].map((key) => [key, { items: [] }]),
    ),
  },
}));
vi.mock("./resource-search-client", () => ({
  searchContextId: () => state.id,
  createResourceSearchTransport: () => ({}),
  createResourceSearchClient: () => ({ query: state.query, clear: state.clear }),
}));
vi.mock("./resource-search-sync", () => ({
  createSearchSynchronizer: (options: { onStatus: (status: unknown) => void; signal: AbortSignal }) => {
    state.syncSignal = options.signal;
    state.coverage = options.onStatus;
    return { run: state.run };
  },
}));
vi.mock("./resource-search-routing", () => ({ openSearchResource: state.open, closeSearchResourceFallback: vi.fn() }));
vi.mock("mobx", () => ({
  reaction: (read: () => unknown, callback: () => void) => {
    if (typeof read() === "boolean") state.preference = callback;
    else state.callback = callback;
    return () => {};
  },
}));
vi.mock("./ai-diagnostic-handoff", () => ({ explainDiagnosticFinding: state.explain }));
vi.mock("./diagnostic-explain-button", () => ({
  DiagnosticExplainButton: (props: object) => <button type="button" {...props} />,
}));

import { ResourceSearchLauncher, startResourceSearch } from "./resource-search";

let stop: (() => void) | undefined;
afterEach(() => {
  act(() => stop?.());
  document.body.innerHTML = "";
  state.id = "cluster-a";
  state.searchEnabled = true;
  vi.clearAllMocks();
});
const resource = (name: string, kind = "Secret") => ({
  name,
  kind,
  group: "",
  version: "v1",
  resource: "secrets",
  path: `/api/v1/namespaces/default/secrets/${name}`,
  namespace: "default",
  labels: {},
});
async function launch(documents = [resource("credentials")], hasMore = false) {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.run.mockImplementation(() => new Promise(() => {}));
  state.query.mockResolvedValue({ documents, total: documents.length, hasMore });
  state.open.mockResolvedValue(undefined);
  act(() => {
    stop = startResourceSearch();
  });
  render(<ResourceSearchLauncher />);
  fireEvent.click(screen.getByLabelText("Search resources"));
  await screen.findAllByText(documents[0].name);
}
it("queries the local index and opens Secrets through the shared exact-route helper", async () => {
  await launch();
  expect(state.query).toHaveBeenCalledWith("", 100, {});
  fireEvent.click(screen.getByText("credentials"));
  await waitFor(() => expect(state.open).toHaveBeenCalledWith(resource("credentials")));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("supports keyboard selection and safe identity AI attachments", async () => {
  await launch([resource("alpha"), resource("beta")]);
  const input = screen.getByLabelText("Resource name, namespace, kind, label or indexed text");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(state.open).toHaveBeenCalledWith(resource("beta")));
});
it("requests a larger bounded result page without a Kubernetes request per key", async () => {
  await launch(undefined, true);
  fireEvent.click(screen.getByText("Show more matches"));
  await waitFor(() => expect(state.query).toHaveBeenCalledWith("", 200, {}));
  fireEvent.change(screen.getByLabelText("Resource name, namespace, kind, label or indexed text"), {
    target: { value: "credentials" },
  });
  await waitFor(() => expect(state.query).toHaveBeenCalledWith("credentials", 200, {}));
});
it("closes on cluster change and ignores replies from the old partition", async () => {
  await launch();
  act(() => {
    state.id = "cluster-b";
    state.callback();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("attaches metadata identity without submitting a message", async () => {
  await launch();
  fireEvent.click(screen.getByLabelText("Ask AI about Secret credentials"));
  expect(state.explain).toHaveBeenCalledWith(
    expect.objectContaining({ resource: { kind: "Secret", name: "credentials", namespace: "default" } }),
  );
});
it("starts background inventory independently of opening the dialog", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.run.mockImplementation(() => new Promise(() => {}));
  act(() => {
    stop = startResourceSearch();
  });
  expect(state.run).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("passes exact type and namespace filters to the persistent query rather than filtering a truncated page", async () => {
  await launch();
  fireEvent.change(screen.getByLabelText("Filter by exact resource kind"), { target: { value: "Secret" } });
  fireEvent.change(screen.getByLabelText("Filter by exact namespace"), { target: { value: "default" } });
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 100, { kind: "Secret", namespace: "default" }));
});

it("offers native discovered suggestions and canonicalizes lowercase kind input", async () => {
  await launch();
  act(() =>
    state.coverage({
      scanned: 1,
      discovered: 1,
      denied: 0,
      unavailable: 0,
      unsupported: 0,
      indexing: false,
      completedAt: Date.now(),
      kinds: ["Pod", "Secret"],
      namespaces: ["default"],
    }),
  );
  expect(document.querySelector('#power-search-kinds option[value="Pod"]')).not.toBeNull();
  expect(document.querySelector('#power-search-namespaces option[value="default"]')).not.toBeNull();
  fireEvent.change(screen.getByLabelText("Filter by exact resource kind"), { target: { value: "pod" } });
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 100, { kind: "Pod" }));
  expect(screen.getByRole("status").textContent).toContain("Updated");
  expect(screen.queryByText(/Aggregated APIs may transfer/)).toBeNull();
  expect(screen.getByText("Search options").parentElement?.hasAttribute("open")).toBe(false);
});
it("reports cache clearing failures instead of leaving an unhandled rejection", async () => {
  await launch();
  state.clear.mockRejectedValueOnce(new Error("Unavailable"));
  fireEvent.click(screen.getByText("Clear local search cache"));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Could not clear");
});

it("keeps full API identities distinct in safe AI summaries for identical kind/name pairs", async () => {
  const first = {
    ...resource("sample", "Widget"),
    group: "first.example",
    version: "v1",
    resource: "widgets",
    uid: "first-uid",
    path: "/apis/first.example/v1/namespaces/default/widgets/sample",
    data: { token: "private-value" },
  };
  const second = {
    ...first,
    group: "second.example",
    uid: "second-uid",
    path: "/apis/second.example/v1/namespaces/default/widgets/sample",
  };
  await launch([first, second]);
  fireEvent.click(screen.getAllByLabelText("Ask AI about Widget sample")[0]);
  expect(state.explain.mock.calls[0][0].summary).toContain("API group: first.example; version: v1; resource: widgets");
  expect(state.explain.mock.calls[0][0].summary).toContain("UID: first-uid");
  fireEvent.click(screen.getByLabelText("Search resources"));
  await screen.findAllByLabelText("Ask AI about Widget sample");
  fireEvent.click(screen.getAllByLabelText("Ask AI about Widget sample")[1]);
  expect(state.explain.mock.calls[1][0].summary).toContain("API group: second.example");
  expect(state.explain.mock.calls[1][0].summary).toContain("UID: second-uid");
  expect(JSON.stringify(state.explain.mock.calls)).not.toContain("private-value");
});
it("shows a storage-full recovery action while retaining cached results", async () => {
  await launch();
  act(() =>
    state.coverage({
      scanned: 1,
      discovered: 3,
      denied: 0,
      unavailable: 0,
      unsupported: 0,
      indexing: false,
      storageFull: true,
      message: "Search storage is full; clear the local search cache to continue",
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain("indexing is paused");
  expect(screen.getByText("credentials")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clear local search cache" })).toBeTruthy();
});
it("refreshes inventory explicitly without hiding cached results", async () => {
  await launch();
  const calls = state.run.mock.calls.length;
  fireEvent.click(screen.getByLabelText("Refresh resource inventory"));
  expect(state.run.mock.calls).toHaveLength(calls + 1);
  expect(screen.getByText("credentials")).toBeTruthy();
});

it("disables all search listeners, closes the dialog and aborts indexing, then restarts on re-enable", async () => {
  await launch();
  const originalSignal = state.syncSignal;
  act(() => {
    state.searchEnabled = false;
    state.preference(false);
  });
  expect(originalSignal?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  state.query.mockClear();
  const runs = state.run.mock.calls.length;
  window.dispatchEvent(new Event("power-resource-search"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.query).not.toHaveBeenCalled();
  expect(state.run.mock.calls).toHaveLength(runs);
  act(() => {
    state.searchEnabled = true;
    state.preference(true);
  });
  expect(state.run.mock.calls).toHaveLength(runs + 1);
  fireEvent.click(screen.getByLabelText("Search resources"));
  await screen.findByRole("dialog");
});
it("starts with no launcher, search UI, listeners or indexing when the persisted preference is disabled", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.searchEnabled = false;
  state.run.mockImplementation(() => new Promise(() => {}));
  const add = vi.spyOn(window, "addEventListener");
  act(() => {
    stop = startResourceSearch();
  });
  render(<ResourceSearchLauncher />);
  expect(screen.queryByLabelText("Search resources")).toBeNull();
  expect(state.run).not.toHaveBeenCalled();
  expect(add.mock.calls.some(([type]) => ["keydown", "keyup", "power-resource-search"].includes(type))).toBe(false);
  add.mockRestore();
});
