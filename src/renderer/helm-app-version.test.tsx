// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmAppVersionCell } from "./helm-app-version";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Icon: () => <span>Retry</span>, Tooltip: ({ children }: any) => <span>{children}</span> } },
}));
const observers: MockObserver[] = [];
class MockObserver {
  callback: IntersectionObserverCallback;
  disconnected = false;
  options?: IntersectionObserverInit;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.options = options;
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  visible(value = true) {
    this.callback([{ isIntersecting: value } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
const release = { name: "sample", namespace: "default", revision: 1, status: "deployed", secretName: "sample" };
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let context = 0;
function cell(extra: Record<string, unknown> = {}) {
  return <HelmAppVersionCell clusterId="cluster" contextId={`context-${context}`} release={release} {...extra} />;
}
const requests = () => mocks.invoke.mock.calls.filter(([, request]) => request.operation === "app-version");
beforeEach(() => {
  context++;
  observers.length = 0;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "1.2.3" }),
  );
  vi.stubGlobal("IntersectionObserver", MockObserver);
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.unstubAllGlobals();
});

it("loads only visible cells and leaves the table available while loading", async () => {
  const pending = deferred();
  mocks.invoke.mockReturnValue(pending.promise);
  render(
    <div>
      <button>Table action</button>
      {cell()}
    </div>,
  );
  expect(requests()).toHaveLength(0);
  expect(screen.getByText("Table action")).toBeTruthy();
  act(() => observers[0].visible());
  await waitFor(() => expect(requests()).toHaveLength(1));
  expect(requests()[0][1]).toMatchObject({
    operation: "app-version",
    clusterId: "cluster",
    contextId: `context-${context}`,
    namespace: "default",
    name: "sample",
    revision: 1,
  });
  await act(async () => pending.resolve({ ok: true, contextId: `context-${context}`, appVersion: "2.0" }));
  expect(screen.getByText("2.0")).toBeTruthy();
});

it("limits active requests to two and cancels queued and active cells on unmount", async () => {
  const pending = [deferred(), deferred()];
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : pending[requests().length - 1].promise,
  );
  const view = render(
    <>
      {cell()}
      {cell({ release: { ...release, name: "second" } })}
      {cell({ release: { ...release, name: "third" } })}
    </>,
  );
  act(() => {
    for (const observer of observers) observer.visible();
  });
  await waitFor(() => expect(requests()).toHaveLength(2));
  view.unmount();
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "cancel")).toHaveLength(2);
  await act(async () => {
    for (const item of pending) item.resolve({ ok: true, contextId: `context-${context}`, appVersion: "late" });
  });
  expect(requests()).toHaveLength(2);
});

it("deduplicates visible identical cells and preserves a shared request when one unmounts", async () => {
  const pending = deferred();
  mocks.invoke.mockReturnValue(pending.promise);
  const view = render(
    <>
      {cell()}
      <div key="other">{cell()}</div>
    </>,
  );
  act(() => {
    for (const observer of observers) observer.visible();
  });
  await waitFor(() => expect(requests()).toHaveLength(1));
  view.rerender(
    <>
      <div key="other">{cell()}</div>
    </>,
  );
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "cancel")).toHaveLength(0);
  await act(async () => pending.resolve({ ok: true, contextId: `context-${context}`, appVersion: "shared" }));
  expect(screen.getByText("shared")).toBeTruthy();
});

it("caches only the exact context/revision and bypasses cache after an explicit refresh", async () => {
  const first = render(cell({ refreshToken: 1 }));
  act(() => observers[0].visible());
  await screen.findByText("1.2.3");
  await act(async () => {});
  first.unmount();
  const second = render(cell({ refreshToken: 1 }));
  act(() => observers[1].visible());
  await screen.findByText("1.2.3");
  expect(requests()).toHaveLength(1);
  second.rerender(cell({ refreshToken: 2 }));
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1][1].refresh).toBe(true);
});

it("discards mismatched context data and offers an isolated retry", async () => {
  mocks.invoke.mockResolvedValueOnce({ ok: true, contextId: "obsolete", appVersion: "wrong" });
  render(cell());
  act(() => observers[0].visible());
  const retry = await screen.findByRole("button", { name: /Retry application version/ });
  expect(screen.queryByText("wrong")).toBeNull();
  fireEvent.click(retry);
  await screen.findByText("1.2.3");
  expect(requests()).toHaveLength(2);
});

it("suspends covered cells and requires visibility again after resuming", async () => {
  const view = render(cell({ active: false }));
  expect(observers).toHaveLength(0);
  expect(requests()).toHaveLength(0);
  view.rerender(cell({ active: true }));
  expect(requests()).toHaveLength(0);
  act(() => observers[0].visible());
  await screen.findByText("1.2.3");
});

it("uses explicit per-cell loading when IntersectionObserver is unavailable", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  render(cell());
  expect(requests()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: /Load application version/ }));
  await screen.findByText("1.2.3");
});

it("cancels a reused cell on context changes and ignores the obsolete response", async () => {
  const old = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel"
      ? Promise.resolve({ ok: true })
      : request.contextId === `context-${context}`
        ? old.promise
        : Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "new-context" }),
  );
  const view = render(cell());
  act(() => observers[0].visible());
  await waitFor(() => expect(requests()).toHaveLength(1));
  view.rerender(cell({ contextId: "changed-context" }));
  expect(
    mocks.invoke.mock.calls.some(
      ([, request]) => request.operation === "cancel" && request.requestId === requests()[0][1].requestId,
    ),
  ).toBe(true);
  expect(requests()).toHaveLength(1);
  act(() => observers[1].visible());
  await screen.findByText("new-context");
  await act(async () => old.resolve({ ok: true, contextId: `context-${context}`, appVersion: "obsolete-value" }));
  expect(screen.queryByText("obsolete-value")).toBeNull();
  expect(screen.getByText("new-context")).toBeTruthy();
});

it("starts the next queued cell as soon as an active request finishes", async () => {
  const pending = [deferred(), deferred(), deferred()];
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : pending[requests().length - 1].promise,
  );
  render(
    <>
      {cell()}
      {cell({ release: { ...release, name: "next" } })}
      {cell({ release: { ...release, name: "queued" } })}
    </>,
  );
  act(() => {
    for (const observer of observers) observer.visible();
  });
  await waitFor(() => expect(requests()).toHaveLength(2));
  await act(async () => pending[0].resolve({ ok: true, contextId: `context-${context}`, appVersion: "first" }));
  await waitFor(() => expect(requests()).toHaveLength(3));
  expect(requests()[2][1].name).toBe("queued");
  await act(async () => {
    for (const item of pending.slice(1)) item.resolve({ ok: true, contextId: `context-${context}` });
  });
  expect(screen.getAllByLabelText("Application version unavailable")).toHaveLength(2);
});

it("partitions cached values by Secret UID and never flashes a replaced release value", async () => {
  const view = render(cell({ release: { ...release, uid: "first-secret" } }));
  act(() => observers[0].visible());
  await screen.findByText("1.2.3");
  await act(async () => {});
  const pending = deferred();
  mocks.invoke.mockReturnValue(pending.promise);
  view.rerender(cell({ release: { ...release, uid: "replacement-secret" } }));
  expect(screen.queryByText("1.2.3")).toBeNull();
  expect(requests()).toHaveLength(1);
  act(() => observers[1].visible());
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1][1].uid).toBe("replacement-secret");
  await act(async () => pending.resolve({ ok: true, contextId: `context-${context}`, appVersion: "replacement" }));
  expect(screen.getByText("replacement")).toBeTruthy();
});

it("keeps retry and manual loading clicks inside the cell", async () => {
  const rowClick = vi.fn();
  vi.stubGlobal("IntersectionObserver", undefined);
  mocks.invoke.mockResolvedValueOnce({ ok: false, error: { code: "failed", message: "Version unavailable" } });
  render(<div onClick={rowClick}>{cell()}</div>);
  fireEvent.click(screen.getByRole("button", { name: /Load application version/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Retry application version/ }));
  await screen.findByText("1.2.3");
  expect(rowClick).not.toHaveBeenCalled();
});

it("observes against the viewport inside a tall auto-overflow wrapper", async () => {
  render(
    <div style={{ height: 200, overflow: "auto" }}>
      <div style={{ overflow: "auto" }}>
        <div style={{ height: 880 }}>{cell()}</div>
      </div>
    </div>,
  );
  expect(observers[0].options?.root).toBeNull();
  act(() => observers[0].visible(false));
  await act(async () => {});
  expect(requests()).toHaveLength(0);
  act(() => observers[0].visible(true));
  await screen.findByText("1.2.3");
});

it("uses a retained index summary after its shared cache entry was evicted", async () => {
  const firstRelease = { ...release, uid: "retained-uid" };
  let retained: import("./helm-version-index").HelmVersion | undefined;
  const { helmVersionIdentity, subscribeHelmVersion } = await import("./helm-version-index");
  for (let index = 0; index <= 1000; index++) {
    const item = index ? { ...release, name: `eviction-${index}`, uid: `uid-${index}` } : firstRelease;
    await new Promise<void>((resolve) =>
      subscribeHelmVersion(
        helmVersionIdentity("cluster", `context-${context}`, item),
        {
          requestId: `prime-${index}`,
          clusterId: "cluster",
          contextId: `context-${context}`,
          namespace: item.namespace,
          name: item.name,
          revision: item.revision,
          uid: item.uid,
          operation: "app-version",
        },
        false,
        (result) => {
          if (!index && "value" in result) retained = result.value;
          resolve();
        },
      ),
    );
  }
  await act(async () => {});
  const count = requests().length;
  render(cell({ release: firstRelease, knownVersion: retained }));
  expect(screen.getByText("1.2.3")).toBeTruthy();
  expect(observers).toHaveLength(0);
  expect(requests()).toHaveLength(count);
});

it("renders a known missing version without observation or additional reads", () => {
  render(cell({ knownVersion: {} }));
  expect(screen.getByLabelText("Application version unavailable")).toBeTruthy();
  expect(observers).toHaveLength(0);
  expect(requests()).toHaveLength(0);
});

it("updates supplied summaries immediately and hides them on context or UID replacement", () => {
  const view = render(cell({ knownVersion: { appVersion: "known-old" } }));
  view.rerender(cell({ knownVersion: { appVersion: "known-new" } }));
  expect(screen.queryByText("known-old")).toBeNull();
  expect(screen.getByText("known-new")).toBeTruthy();
  view.rerender(cell({ contextId: "changed-context", release: { ...release, uid: "replaced-secret" } }));
  expect(screen.queryByText("known-new")).toBeNull();
  expect(screen.getByLabelText("Application version pending")).toBeTruthy();
  expect(requests()).toHaveLength(0);
});

it("cancels a cell-owned read when an index summary arrives and ignores its late response", async () => {
  const pending = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : pending.promise,
  );
  const view = render(cell());
  act(() => observers[0].visible());
  await waitFor(() => expect(requests()).toHaveLength(1));
  view.rerender(cell({ knownVersion: { appVersion: "indexed" } }));
  expect(screen.getByText("indexed")).toBeTruthy();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel")).toBe(true);
  await act(async () => pending.resolve({ ok: true, contextId: `context-${context}`, appVersion: "late-owned" }));
  expect(screen.queryByText("late-owned")).toBeNull();
  expect(screen.getByText("indexed")).toBeTruthy();
});

it("does not flash an older owned value when an explicit refresh clears a supplied summary", async () => {
  const view = render(cell({ refreshToken: 1 }));
  act(() => observers[0].visible());
  await screen.findByText("1.2.3");
  view.rerender(cell({ refreshToken: 1, knownVersion: { appVersion: "indexed" } }));
  expect(screen.getByText("indexed")).toBeTruthy();
  view.rerender(cell({ refreshToken: 2 }));
  expect(screen.queryByText("indexed")).toBeNull();
  expect(screen.queryByText("1.2.3")).toBeNull();
  expect(screen.getByLabelText("Application version pending")).toBeTruthy();
});
