// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmAppVersionCell } from "./helm-app-version";
import { helmVersionIdentity, subscribeHelmVersion, useHelmVersionIndex } from "./helm-version-index";

import type { HelmReleaseMetadata } from "../common/helm";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Icon: () => <span>Retry</span>, Tooltip: ({ children }: any) => <span>{children}</span> } },
}));
let context = 0;
const pending: Array<{ resolve: (value: any) => void }> = [];
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  const entry = { promise, resolve };
  pending.push(entry);
  return entry;
}
const rows: HelmReleaseMetadata[] = Array.from({ length: 3 }, (_, index) => ({
  name: `release-${index}`,
  namespace: "sample",
  revision: 1,
  uid: `uid-${index}`,
  secretName: `secret-${index}`,
  status: "deployed",
}));
function View({
  releases = rows,
  active = true,
  refreshToken = 1,
  contextId = `context-${context}`,
}: {
  releases?: HelmReleaseMetadata[];
  active?: boolean;
  refreshToken?: number;
  contextId?: string;
}) {
  const index = useHelmVersionIndex({ clusterId: "cluster", contextId, releases, active, refreshToken });
  return (
    <div>
      <div data-testid="metadata">{releases.map((release) => release.name).join(",")}</div>
      <div data-testid="progress">
        {index.completed}/{index.total}/{index.errors}/{String(index.loading)}/{String(index.paused)}
      </div>
      <div data-testid="versions">
        {releases.map((release) => index.versionFor(release)?.appVersion ?? "?").join(",")}
      </div>
      <div data-testid="matches">
        {releases
          .filter((release) => index.versionFor(release)?.appVersion?.includes("2.0"))
          .map((release) => release.name)
          .join(",")}
      </div>
    </div>
  );
}
const requests = () => mocks.invoke.mock.calls.filter(([, request]) => request.operation === "app-version");
beforeEach(() => {
  context++;
  pending.length = 0;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "2.0" }),
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const item of pending) item.resolve({ ok: true, contextId: "cancelled" });
  });
  vi.unstubAllGlobals();
});

it("paints metadata immediately and incrementally searches all versions without visibility", async () => {
  const first = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.name === rows[0].name && request.operation !== "cancel"
      ? first.promise
      : Promise.resolve({
          ok: true,
          contextId: request.contextId,
          appVersion: request.name === rows[1].name ? "1.0" : "2.0",
        }),
  );
  render(<View />);
  expect(screen.getByTestId("metadata").textContent).toContain("release-2");
  expect(requests()).toHaveLength(0);
  expect(screen.getByTestId("progress").textContent).toBe("0/3/0/true/false");
  await waitFor(() => expect(requests()).toHaveLength(1));
  expect(screen.getByTestId("matches").textContent).toBe("");
  await act(async () => first.resolve({ ok: true, contextId: `context-${context}`, appVersion: "2.0" }));
  await waitFor(() => expect(screen.getByTestId("matches").textContent).toBe("release-0"));
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("3/3/0/false/false"));
  expect(screen.getByTestId("matches").textContent).toBe("release-0,release-2");
});

it("runs one paced background request at a time and gives visible work the next free slot", async () => {
  const response = new Map<string, ReturnType<typeof deferred>>();
  mocks.invoke.mockImplementation((_channel, request) => {
    if (request.operation === "cancel") return Promise.resolve({ ok: true });
    const entry = deferred();
    response.set(request.name, entry);
    return entry.promise;
  });
  render(<View releases={rows.slice(0, 2)} />);
  await waitFor(() => expect(requests()).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(requests()).toHaveLength(1);
  const cancel: Array<() => void> = [];
  for (const name of ["visible-1", "visible-2"])
    cancel.push(
      subscribeHelmVersion(
        name,
        {
          requestId: name,
          clusterId: "cluster",
          contextId: `context-${context}`,
          namespace: "sample",
          name,
          revision: 1,
          operation: "app-version",
        },
        false,
        () => undefined,
      ),
    );
  await waitFor(() => expect(requests()).toHaveLength(2));
  await act(async () =>
    response.get("release-0")!.resolve({ ok: true, contextId: `context-${context}`, appVersion: "2.0" }),
  );
  await waitFor(() => expect(requests()).toHaveLength(3));
  expect(requests()[2][1].name).toBe("visible-2");
  await act(async () => response.get("visible-1")!.resolve({ ok: true, contextId: `context-${context}` }));
  await waitFor(() => expect(requests()).toHaveLength(4));
  expect(requests()[3][1].name).toBe("release-1");
  for (const stop of cancel) stop();
});

it("preserves completed work while paused and cancels unfinished work", async () => {
  const second = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" || request.name === "release-0"
      ? Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "2.0" })
      : second.promise,
  );
  const view = render(<View releases={rows.slice(0, 2)} />);
  await waitFor(() => expect(requests()).toHaveLength(2));
  view.rerender(<View releases={rows.slice(0, 2)} active={false} />);
  expect(screen.getByTestId("progress").textContent).toBe("1/2/0/false/true");
  expect(screen.getByTestId("versions").textContent).toBe("2.0,?");
  expect(
    mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel" && request.name === "release-1"),
  ).toBe(true);
  await act(async () => second.resolve({ ok: true, contextId: `context-${context}`, appVersion: "obsolete" }));
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "resumed" }),
  );
  view.rerender(<View releases={rows.slice(0, 2)} />);
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("2/2/0/false/false"));
  expect(screen.getByTestId("versions").textContent).toBe("2.0,resumed");
  expect(requests().filter(([, request]) => request.name === "release-0")).toHaveLength(1);
});

it("deduplicates rows, uses cached identities, and refreshes only when the token changes", async () => {
  const view = render(<View releases={[rows[0], rows[0]]} />);
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("1/1/0/false/false"));
  expect(requests()).toHaveLength(1);
  view.unmount();
  const next = render(<View releases={[rows[0]]} />);
  await waitFor(() => expect(screen.getByTestId("versions").textContent).toBe("2.0"));
  expect(requests()).toHaveLength(1);
  next.rerender(<View releases={[rows[0]]} refreshToken={2} />);
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1][1].refresh).toBe(true);
});

it("counts failures as settled without retry loops and rejects obsolete context and UID results", async () => {
  mocks.invoke.mockResolvedValueOnce({ ok: false, error: { code: "forbidden", message: "Unavailable" } });
  const view = render(<View releases={[rows[0]]} />);
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("1/1/1/false/false"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(requests()).toHaveLength(1);
  view.rerender(<View releases={[{ ...rows[0], uid: "replacement" }]} contextId="replacement-context" />);
  expect(screen.getByTestId("versions").textContent).toBe("?");
  await waitFor(() => expect(screen.getByTestId("versions").textContent).toBe("2.0"));
  expect(requests()[1][1]).toMatchObject({ contextId: "replacement-context", uid: "replacement" });
});

it("promotes a shared queued background identity when its visible cell subscribes", async () => {
  render(<View releases={[rows[0]]} />);
  const key = helmVersionIdentity("cluster", `context-${context}`, rows[0]);
  const listener = vi.fn();
  const stop = subscribeHelmVersion(
    key,
    {
      requestId: "visible",
      clusterId: "cluster",
      contextId: `context-${context}`,
      namespace: rows[0].namespace,
      name: rows[0].name,
      revision: 1,
      uid: rows[0].uid,
      operation: "app-version",
    },
    false,
    listener,
  );
  await waitFor(() => expect(listener).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("1/1/0/false/false"));
  expect(requests()).toHaveLength(1);
  stop();
});

it("cancels the initial pacing delay before any background read starts", async () => {
  const view = render(<View />);
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(requests()).toHaveLength(0);
});

it("refreshes independently of older visible work and prevents its late response from replacing fresh cache", async () => {
  const old = deferred();
  const fresh = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : request.refresh ? fresh.promise : old.promise,
  );
  const key = helmVersionIdentity("cluster", `context-${context}`, rows[0]);
  const stop = subscribeHelmVersion(
    key,
    {
      requestId: "old-visible",
      clusterId: "cluster",
      contextId: `context-${context}`,
      namespace: rows[0].namespace,
      name: rows[0].name,
      revision: 1,
      uid: rows[0].uid,
      operation: "app-version",
    },
    false,
    () => undefined,
  );
  const view = render(<View releases={[rows[0]]} active={false} />);
  await waitFor(() => expect(requests()).toHaveLength(1));
  view.rerender(<View releases={[rows[0]]} refreshToken={2} />);
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1][1].refresh).toBe(true);
  await act(async () => fresh.resolve({ ok: true, contextId: `context-${context}`, appVersion: "fresh" }));
  expect(screen.getByTestId("versions").textContent).toBe("fresh");
  await act(async () => old.resolve({ ok: true, contextId: `context-${context}`, appVersion: "obsolete" }));
  stop();
  view.unmount();
  render(<View releases={[rows[0]]} refreshToken={2} />);
  await waitFor(() => expect(screen.getByTestId("versions").textContent).toBe("fresh"));
  expect(requests()).toHaveLength(2);
});

it("repairs indexed search and error progress after a visible cell retries successfully", async () => {
  const first = deferred();
  let showVisible!: () => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        showVisible = () =>
          callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : first.promise,
  );
  render(
    <>
      <View releases={[rows[0]]} />
      <HelmAppVersionCell clusterId="cluster" contextId={`context-${context}`} release={rows[0]} refreshToken={1} />
    </>,
  );
  await waitFor(() => expect(requests()).toHaveLength(1));
  act(() => showVisible());
  await act(async () =>
    first.resolve({ ok: false, error: { code: "failed", message: "Version temporarily unavailable" } }),
  );
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("1/1/1/false/false"));
  const retry = await screen.findByRole("button", { name: /Retry application version/ });
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve({ ok: true, contextId: request.contextId, appVersion: "2.0" }),
  );
  fireEvent.click(retry);
  await screen.findByText("2.0");
  await waitFor(() => expect(screen.getByTestId("progress").textContent).toBe("1/1/0/false/false"));
  expect(screen.getByTestId("matches").textContent).toBe("release-0");
  expect(screen.getByTestId("versions").textContent).toBe("2.0");
  expect(requests()).toHaveLength(2);
});

it("batches a thousand warm-cache completions across a twenty-thousand-row dataset", async () => {
  const large = Array.from({ length: 20_000 }, (_, index) => ({
    ...rows[0],
    name: `warm-${index}`,
    uid: `warm-uid-${index}`,
  }));
  for (const release of large.slice(0, 1000)) {
    await new Promise<void>((resolve) =>
      subscribeHelmVersion(
        helmVersionIdentity("cluster", `context-${context}`, release),
        {
          requestId: release.name,
          clusterId: "cluster",
          contextId: `context-${context}`,
          namespace: release.namespace,
          name: release.name,
          revision: release.revision,
          uid: release.uid,
          operation: "app-version",
        },
        false,
        () => resolve(),
      ),
    );
  }
  await act(async () => {});
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : deferred().promise,
  );
  let renders = 0;
  function Benchmark() {
    renders++;
    const index = useHelmVersionIndex({ clusterId: "cluster", contextId: `context-${context}`, releases: large });
    return (
      <div data-testid="warm-progress">
        {index.completed}/{index.total}/{index.errors}/{index.versions.size}
      </div>
    );
  }
  render(<Benchmark />);
  await waitFor(() => expect(screen.getByTestId("warm-progress").textContent).toBe("1000/20000/0/1000"));
  expect(renders).toBeLessThanOrEqual(50);
});
