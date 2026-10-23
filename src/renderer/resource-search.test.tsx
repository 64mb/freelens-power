// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  id: "cluster-a",
  cachedCount: 1,
  cachedOverrides: {} as Record<
    string,
    {
      metadata: { name: string; namespace?: string; labels?: Record<string, string> };
      selfLink: string;
      spec?: unknown;
      status?: unknown;
    }[]
  >,
  callback: () => {},
  list: vi.fn(),
  explain: vi.fn(),
  details: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.id } }) } },
    Navigation: { showDetails: state.details },
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
      ].map((key) => [
        key,
        {
          get items() {
            if (state.cachedOverrides[key]) return state.cachedOverrides[key];
            return Array.from({ length: state.cachedCount }, (_, index) => ({
              metadata: { name: state.cachedCount === 1 ? "api" : `cached-${index}`, namespace: "default" },
              selfLink: `/${key}/${state.cachedCount === 1 ? "api" : index}`,
            }));
          },
          api: { list: (...args: unknown[]) => state.list(key, ...args) },
        },
      ]),
    ),
  },
}));
vi.mock("mobx", () => ({
  reaction: (_read: unknown, callback: () => void) => {
    state.callback = callback;
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
  state.cachedCount = 1;
  state.cachedOverrides = {};
  vi.clearAllMocks();
});
it("opens from the launcher, searches cached kinds and hands the selected identity to AI", async () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  render(<ResourceSearchLauncher />);
  fireEvent.click(screen.getByRole("button", { name: "Search resources" }));
  const input = screen.getByRole("textbox");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Pod default" } });
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Ask AI about Pod api" }));
  expect(state.explain).toHaveBeenCalledWith(
    expect.objectContaining({ clusterId: "cluster-a", resource: { kind: "Pod", name: "api", namespace: "default" } }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("closes on cluster change and ignores outstanding responses", async () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  let resolve: (value: unknown[]) => void = () => {};
  state.list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  state.id = "cluster-b";
  act(() => state.callback());
  await act(async () => {
    resolve([{ metadata: { name: "stale" }, selfLink: "/stale" }]);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.details).not.toHaveBeenCalled();
});
it("opens the keyboard selection and restores launcher focus after Escape", async () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  render(<ResourceSearchLauncher />);
  const launcher = screen.getByRole("button", { name: "Search resources" });
  launcher.focus();
  fireEvent.click(launcher);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Service default" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await act(async () => {});
  expect(state.details).toHaveBeenCalledWith("/serviceStore/api");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(launcher);
  fireEvent.click(launcher);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(launcher);
});
it("preserves the selected resource when a deferred kind response inserts an earlier result", async () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  let resolvePods: (value: unknown[]) => void = () => {};
  state.list.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolvePods = done;
      }),
  );
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "api" } });
  for (let index = 0; index < 10; index++) fireEvent.keyDown(input, { key: "ArrowDown" });
  const selectedName = () => document.querySelector(".power-resource-search-row.selected")?.textContent;
  expect(selectedName()).toContain("Service");
  await act(async () => {
    resolvePods([
      { metadata: { name: "api", namespace: "default" }, selfLink: "/podsStore/api" },
      { metadata: { name: "api-added", namespace: "default" }, selfLink: "/podsStore/api-added" },
    ]);
  });
  expect(selectedName()).toContain("Service");
  fireEvent.keyDown(input, { key: "Enter" });
  await act(async () => {});
  expect(state.details).toHaveBeenCalledWith("/serviceStore/api");
});
it("keeps host drawer outside-click listeners from receiving search mouse events", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  const hostOutsideClick = vi.fn();
  window.addEventListener("mousedown", hostOutsideClick);
  window.addEventListener("click", hostOutsideClick);
  try {
    fireEvent.mouseDown(screen.getByRole("textbox"));
    fireEvent.click(screen.getByRole("textbox"));
    expect(hostOutsideClick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(document.querySelector(".power-resource-search-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hostOutsideClick).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("mousedown", hostOutsideClick);
    window.removeEventListener("click", hostOutsideClick);
  }
});
it("caps cached inventory to 500 objects per kind before searching", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.cachedCount = 510;
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "cached-509" } });
  expect(screen.queryByText("cached-509", { exact: true })).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "cached-499" } });
  expect(screen.getAllByText("cached-499", { exact: true })).toHaveLength(12);
});
it("recognizes intentional double Shift inside a filter but ignores IME input", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  const filter = document.createElement("input");
  document.body.append(filter);
  filter.focus();
  fireEvent.keyDown(filter, { key: "Shift", isComposing: true });
  fireEvent.keyUp(filter, { key: "Shift" });
  fireEvent.keyDown(filter, { key: "Shift", isComposing: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyUp(filter, { key: "Shift" });
  fireEvent.keyDown(filter, { key: "Shift" });
  fireEvent.keyUp(filter, { key: "Shift" });
  fireEvent.keyDown(filter, { key: "Shift" });
  expect(screen.getByRole("dialog")).toBeTruthy();
});
it("automatically selects the best newly loaded match until keyboard selection is explicit", async () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.cachedOverrides = {
    podsStore: [{ metadata: { name: "backend", labels: { service: "api" } }, selfLink: "/pods/backend" }],
    serviceStore: [],
  };
  let resolveServices: (value: unknown[]) => void = () => {};
  state.list.mockImplementation((kind: string) =>
    kind === "serviceStore"
      ? new Promise((resolve) => {
          resolveServices = resolve;
        })
      : Promise.resolve(kind === "podsStore" ? state.cachedOverrides.podsStore : []),
  );
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Service" } });
  expect(document.querySelector(".power-resource-search-row.selected")?.textContent).toContain("Pod");
  await act(async () => {});
  await act(async () => {
    resolveServices([{ metadata: { name: "backend", namespace: "default" }, selfLink: "/services/backend" }]);
  });
  expect(document.querySelector(".power-resource-search-row.selected")?.textContent).toContain("Service");
  fireEvent.keyDown(input, { key: "Enter" });
  await act(async () => {});
  expect(state.details).toHaveBeenCalledWith("/services/backend");
});
it("shows safe indexed snippets, highlights text, and labels approximate name matches", () => {
  Object.defineProperty(window, "top", { configurable: true, value: {} });
  state.cachedOverrides.podsStore = [
    {
      metadata: { name: "backend", namespace: "default" },
      selfLink: "/pods/backend",
      spec: { containers: [{ name: "api", image: "example/backend:v3" }] },
    },
  ];
  state.list.mockImplementation(() => new Promise(() => {}));
  stop = startResourceSearch();
  act(() => {
    window.dispatchEvent(new Event("power-resource-search"));
  });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "backend:v3" } });
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(document.querySelector(".power-resource-search-snippet")?.textContent).toBe("Image: example/backend:v3");
  expect(document.querySelector("mark")?.textContent).toBe("backend:v3");
  fireEvent.change(input, { target: { value: "bakcend" } });
  expect(screen.getByText("Similar name")).toBeTruthy();
  expect(input.getAttribute("maxlength")).toBe("300");
});
