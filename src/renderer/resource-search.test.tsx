// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
vi.mock("react-select", () => ({
  default: ({
    options,
    value,
    onChange,
    onMenuOpen,
    onMenuClose,
    "aria-label": label,
  }: {
    options: { value: string; label: string }[];
    value: { value: string; label: string } | null;
    onChange: (option: { value: string; label: string } | undefined) => void;
    onMenuOpen: () => void;
    onMenuClose: () => void;
    "aria-label": string;
  }) => (
    <select
      aria-label={label}
      value={value?.value ?? ""}
      onMouseDown={onMenuOpen}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onMenuClose();
        }
      }}
      onChange={(event) => onChange(options.find((option) => option.value === event.target.value))}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: { Tooltip: () => null },
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
    state.coverage({ scanned: 0, discovered: 0, denied: 0, unavailable: 0, unsupported: 0, indexing: true });
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
it("closes an open select before the dialog even when closed selects also prevent Escape", async () => {
  await launch();
  const kind = screen.getByRole("combobox", { name: "Kind" });
  fireEvent.mouseDown(kind);
  fireEvent.keyDown(kind, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(kind, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("requests a larger bounded result page without a Kubernetes request per key", async () => {
  await launch(undefined, true);
  fireEvent.click(screen.getByText("Show all matches"));
  await waitFor(() => expect(state.query).toHaveBeenCalledWith("", 1000, {}));
  fireEvent.change(screen.getByLabelText("Resource name, namespace, kind, label or indexed text"), {
    target: { value: "credentials" },
  });
  await waitFor(() => expect(state.query).toHaveBeenCalledWith("credentials", 100, {}));
});
it.each(["success", "failure"])("shows pending pagination and restores the control after %s", async (outcome) => {
  await launch([resource("alpha"), resource("beta")], true);
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  state.query.mockImplementationOnce(
    () =>
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all matches" }));
  const pending = screen.getByRole("button", { name: "Loading matches… 2 / 2" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  expect(pending.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(pending);
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 1000, {}));
  expect(state.query).toHaveBeenCalledTimes(2);
  const input = screen.getByLabelText("Resource name, namespace, kind, label or indexed text");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await act(async () => {
    if (outcome === "success")
      resolve({ documents: [resource("alpha"), resource("beta"), resource("gamma")], total: 3, hasMore: false });
    else reject(new Error("unavailable"));
  });
  if (outcome === "failure") {
    const ready = screen.getByRole("button", { name: "Show all matches" }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    expect(ready.getAttribute("aria-busy")).toBe("false");
  } else expect(screen.queryByRole("button", { name: /Loading matches/ })).toBeNull();
  if (outcome === "success") expect(screen.getByText("gamma")).toBeTruthy();
  else expect(screen.getByText(/Search cache unavailable/)).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(state.open).toHaveBeenCalledWith(resource("beta")));
});
it("loads every remaining page with one click and reports page progress", async () => {
  await launch([resource("alpha")], true);
  let finish!: (value: unknown) => void;
  state.query.mockResolvedValueOnce({ documents: [resource("alpha"), resource("beta")], total: 3, hasMore: true });
  state.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all matches" }));
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 1000, { offset: 2 }));
  expect(screen.getByRole("button", { name: "Loading matches… 2 / 3" })).toBeTruthy();
  await act(async () => finish({ documents: [resource("gamma")], total: 3, hasMore: false }));
  expect(screen.getByText("gamma")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /matches/ })).toBeNull();
});
it.each([
  "during pagination",
  "after pagination",
])("refreshes all matches once when indexing completes %s", async (completion) => {
  const documents = Array.from({ length: 21 }, (_, index) => resource(`resource-${index}`));
  await launch(documents.slice(0, 10), true);
  let finish!: (value: unknown) => void;
  state.query.mockResolvedValueOnce({ documents: documents.slice(0, 10), total: documents.length, hasMore: true });
  state.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  state.query.mockResolvedValueOnce({ documents: documents.slice(20), total: documents.length, hasMore: false });
  let finishRefresh!: (value: unknown) => void;
  state.query.mockResolvedValueOnce({ documents: documents.slice(0, 10), total: 22, hasMore: true });
  state.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all matches" }));
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 1000, { offset: 10 }));
  for (const indexing of completion === "during pagination" ? [true, false] : [true]) {
    act(() =>
      state.coverage({
        scanned: indexing ? 10 : 20,
        discovered: 20,
        denied: 0,
        unavailable: 0,
        unsupported: 0,
        indexing,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(state.query).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Loading matches… 10 / 21" })).toBeTruthy();
  }
  await act(async () => finish({ documents: documents.slice(10, 20), total: documents.length, hasMore: true }));
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 1000, { offset: 20 }));
  expect(screen.getAllByRole("listitem")).toHaveLength(21);
  if (completion === "after pagination") {
    act(() =>
      state.coverage({ scanned: 20, discovered: 20, denied: 0, unavailable: 0, unsupported: 0, indexing: false }),
    );
  }
  await waitFor(() => expect(state.query).toHaveBeenCalledTimes(6));
  expect(screen.getAllByRole("listitem")).toHaveLength(21);
  await act(async () =>
    finishRefresh({ documents: [...documents.slice(10), resource("newly-indexed")], total: 22, hasMore: false }),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(22);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(state.query).toHaveBeenCalledTimes(6);
  expect(screen.queryByRole("button", { name: /matches/ })).toBeNull();
});
it("refreshes all matches after a later scan completes with the same type count", async () => {
  await launch([resource("alpha")], true);
  const coverage = {
    scanned: 20,
    discovered: 20,
    denied: 0,
    unavailable: 0,
    unsupported: 0,
    indexing: false,
    completedAt: 1000,
  };
  act(() => state.coverage(coverage));
  await screen.findByRole("button", { name: "Show all matches" });
  state.query.mockResolvedValue({ documents: [resource("alpha"), resource("beta")], total: 2, hasMore: false });
  fireEvent.click(screen.getByRole("button", { name: "Show all matches" }));
  await screen.findByText("beta");
  const requests = state.query.mock.calls.length;
  act(() => state.coverage({ ...coverage, scanned: 0, indexing: true }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(state.query).toHaveBeenCalledTimes(requests);
  state.query.mockResolvedValue({
    documents: [resource("alpha"), resource("beta"), resource("gamma")],
    total: 3,
    hasMore: false,
  });
  act(() => state.coverage({ ...coverage, completedAt: 2000 }));
  await screen.findByText("gamma");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  expect(state.query).toHaveBeenCalledTimes(requests + 1);
});
it.each(["query", "close"])("stops loading all pages after %s changes", async (change) => {
  await launch([resource("alpha")], true);
  let finish!: (value: unknown) => void;
  state.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all matches" }));
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 1000, {}));
  const input = screen.getByLabelText("Resource name, namespace, kind, label or indexed text");
  if (change === "query") fireEvent.change(input, { target: { value: "beta" } });
  else fireEvent.keyDown(input, { key: "Escape" });
  await act(async () => finish({ documents: [resource("stale")], total: 3, hasMore: true }));
  expect(screen.queryByText("stale")).toBeNull();
  expect(state.query.mock.calls.some((call) => call[2]?.offset)).toBe(false);
  if (change === "query") await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("beta", 100, {}));
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
  act(() =>
    state.coverage({
      scanned: 1,
      discovered: 1,
      denied: 0,
      unavailable: 0,
      unsupported: 0,
      indexing: false,
      kinds: ["Secret"],
      namespaces: ["default"],
    }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "Secret" } });
  fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "default" } });
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 100, { kind: "Secret", namespace: "default" }));
});

it("offers discovered kinds and namespaces through labeled native controls", async () => {
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
      kinds: ["Zebra", "Secret", "Pod", "Alpha", "Deployment", "PersistentVolumeClaim"],
      namespaces: ["default"],
    }),
  );
  expect(screen.getByRole("option", { name: "Pod" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "default" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "All types" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "All namespaces" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Cluster scoped" })).toBeTruthy();
  expect(
    within(screen.getByRole("combobox", { name: "Kind" }))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All types", "Pod", "Deployment", "Secret", "PersistentVolumeClaim", "Alpha", "Zebra"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "Pod" } });
  await waitFor(() => expect(state.query).toHaveBeenLastCalledWith("", 100, { kind: "Pod" }));
  expect(screen.getByRole("status").textContent).toContain("Updated");
  expect(screen.queryByText(/Aggregated APIs may transfer/)).toBeNull();
});
it("reports cache clearing failures instead of leaving an unhandled rejection", async () => {
  await launch();
  state.clear.mockRejectedValueOnce(new Error("Unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Clear local search cache" }));
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
