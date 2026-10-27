// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HelmOperationsPanel, HelmOperationsStore, helmOperations } from "./helm-operations";

import type { HelmOperation, HelmResponse } from "../common/helm";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke }, clipboard: { writeText: mocks.copy } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Dialog: ({ children }: any) => <div>{children}</div>,
      Button: ({ label, onClick, children }: any) => (
        <button onClick={onClick}>
          {label}
          {children}
        </button>
      ),
      Icon: ({ material }: any) => <span aria-hidden="true">{material}</span>,
      Checkbox: ({ label, value, onChange }: any) => (
        <>
          <style>{'.Checkbox input[type="checkbox"] { display:none; }'}</style>
          <label className={`Checkbox flex align-center${value ? " checked" : ""}`} data-native-checkbox>
            <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked, event)} />
            <i className="box flex align-center" />
            <span className="label">{label}</span>
          </label>
        </>
      ),
    },
  },
}));
const operation = (overrides: Partial<HelmOperation> = {}): HelmOperation => ({
  id: "operation",
  requestId: "request",
  clusterId: "cluster",
  contextId: "context",
  namespace: "default",
  name: "example",
  revision: 2,
  status: "running",
  phase: "preparing",
  startedAt: Date.now(),
  logs: [],
  ...overrides,
});
const payload = {
  requestId: "request",
  clusterId: "cluster",
  contextId: "context",
  namespace: "default",
  name: "example",
  revision: 2,
  operation: "rollback" as const,
};
const props = () => ({ clusterId: "cluster", contextId: "context", onChanged: vi.fn(), onViewHistory: vi.fn() });
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  helmOperations.operations = [];
  helmOperations.selectedId = undefined;
  helmOperations.dismissed = [];
  helmOperations.uncertain.clear();
  helmOperations.localTerminal.clear();
  mocks.invoke.mockResolvedValue({ ok: true, operations: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("keeps the task alive after minimization and panel unmount", async () => {
  let finish!: (response: HelmResponse) => void;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "rollback"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ ok: true, operations: [] }),
  );
  const view = render(<HelmOperationsPanel {...props()} />);
  let pending!: Promise<HelmResponse>;
  act(() => {
    pending = helmOperations.start(payload);
  });
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByText("Minimize"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("View progress")).toBeTruthy();
  view.unmount();
  await act(async () => {
    finish({ ok: true });
    await pending;
  });
  expect(helmOperations.operations[0].status).toBe("succeeded");
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel")).toBe(false);
  render(<HelmOperationsPanel {...props()} />);
  expect(screen.getByText(/Completed ·/)).toBeTruthy();
});

it("does not regress terminal results or an advanced phase from stale snapshots", () => {
  const store = new HelmOperationsStore();
  store.merge([operation({ phase: "waiting" })]);
  store.merge([operation({ phase: "applying" })]);
  expect(store.operations[0].phase).toBe("waiting");
  store.merge([
    operation({
      status: "failed",
      phase: "failed",
      finishedAt: 100,
      error: { code: "HELM_ERROR", message: "Rollback failed" },
    }),
  ]);
  store.merge([operation()]);
  store.merge([operation({ status: "succeeded", phase: "completed", finishedAt: 90 })]);
  expect(store.operations[0].status).toBe("failed");
  expect(store.isRunning("cluster", "context", "default", "example")).toBe(false);
});

it("shares polling, rejects another context, and stops timers on final unmount", async () => {
  mocks.invoke.mockResolvedValue({
    ok: true,
    operations: [operation(), operation({ requestId: "foreign", contextId: "foreign" })],
  });
  const first = render(<HelmOperationsPanel {...props()} />);
  const second = render(<HelmOperationsPanel {...props()} />);
  await flush();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(helmOperations.operations).toHaveLength(1);
  first.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  second.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shows safe errors, bounded plain text logs, copy, and history after failure", async () => {
  const callbacks = props();
  const lines = Array.from({ length: 600 }, (_, index) => ({ at: Date.now(), message: `<line-${index}>` }));
  helmOperations.merge([
    operation({
      status: "failed",
      phase: "failed",
      finishedAt: Date.now(),
      logs: lines,
      error: { code: "HELM_ERROR", message: "Helm rollback failed. Check release history." },
    }),
  ]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...callbacks} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  expect(screen.getByRole("alert").textContent).toContain("Check release history");
  fireEvent.click(screen.getByText("Copy log"));
  const copied = mocks.copy.mock.calls[0][0];
  expect(copied).toContain("<line-599>");
  expect(copied).not.toContain("<line-99>");
  expect(copied.split("\n")).toHaveLength(500);
  fireEvent.click(screen.getAllByText("View history").at(-1)!);
  expect(callbacks.onViewHistory).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps uncertain transport failures locked until authoritative snapshots reconcile them", async () => {
  let reject!: (error: Error) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const store = new HelmOperationsStore();
  const result = store.start(payload);
  expect(store.isRunning("cluster", "context", "default", "example")).toBe(true);
  expect(store.isRunning("cluster", "other", "default", "example")).toBe(false);
  expect(await store.start({ ...payload, requestId: "duplicate" })).toMatchObject({
    ok: false,
    error: { code: "OPERATION_RUNNING" },
  });
  reject(new Error("private transport details"));
  expect(await result).toMatchObject({ ok: false, error: { code: "TRANSPORT_ERROR" } });
  expect(store.operations[0].error?.message).not.toContain("private");
  expect(store.operations[0].status).toBe("running");
  expect(store.isRunning("cluster", "context", "default", "example")).toBe(true);
  store.merge([operation({ phase: "applying" })]);
  expect(store.operations[0].phase).toBe("applying");
  expect(store.operations[0].error).toBeUndefined();
  store.merge([operation({ status: "succeeded", phase: "completed", finishedAt: Date.now() })]);
  expect(store.isRunning("cluster", "context", "default", "example")).toBe(false);
});

it("keeps the compact panel limited to running operations and one latest completed card", () => {
  helmOperations.merge([
    operation({ requestId: "running-a", name: "active-a" }),
    operation({ requestId: "running-b", name: "active-b" }),
    operation({ requestId: "older", name: "older", status: "succeeded", phase: "completed", finishedAt: 100 }),
    operation({ requestId: "latest", name: "latest", status: "succeeded", phase: "completed", finishedAt: 200 }),
  ]);
  render(<HelmOperationsPanel {...props()} />);
  expect(screen.getAllByText("View progress")).toHaveLength(3);
  expect(screen.queryByText("older")).toBeNull();
  expect(screen.getByText("latest")).toBeTruthy();
  fireEvent.click(screen.getByText("Dismiss"));
  expect(screen.getByText("older")).toBeTruthy();
  expect(screen.queryByText("latest")).toBeNull();
});

it("returns focus to the progress button when Escape minimizes the modal", async () => {
  helmOperations.merge([operation()]);
  render(<HelmOperationsPanel {...props()} />);
  const button = screen.getByRole("button", { name: "View progress" });
  button.focus();
  fireEvent.click(button);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("resolves missing uncertain tasks only from a poll issued after transport failure", async () => {
  mocks.invoke.mockRejectedValue(new Error("offline"));
  const store = new HelmOperationsStore();
  await store.start(payload);
  const marker = store.uncertain.get(payload.requestId)!;
  store.reconcile([], "cluster", "context", marker);
  expect(store.operations[0].status).toBe("running");
  store.reconcile([], "cluster", "other", marker + 1);
  expect(store.operations[0].status).toBe("running");
  store.reconcile([], "cluster", "context", marker + 1);
  expect(store.operations[0].error?.code).toBe("OPERATION_NOT_FOUND");
  expect(store.isRunning("cluster", "context", "default", "example")).toBe(false);
  store.merge([operation({ phase: "waiting" })]);
  expect(store.operations[0].status).toBe("running");
});

it("replaces synthetic terminal timestamps with authoritative final logs", async () => {
  mocks.invoke.mockResolvedValue({ ok: true });
  const store = new HelmOperationsStore();
  await store.start(payload);
  const finishedAt = Date.now() - 20;
  store.merge([
    operation({
      status: "succeeded",
      phase: "completed",
      finishedAt,
      logs: [{ at: finishedAt, message: "Final backend output" }],
    }),
  ]);
  expect(store.operations[0].finishedAt).toBe(finishedAt);
  expect(store.operations[0].logs[0].message).toBe("Final backend output");
});

it("retains a new completion when the bounded history is already full", () => {
  const store = new HelmOperationsStore();
  store.merge(
    Array.from({ length: 30 }, (_, index) =>
      operation({ requestId: `old-${index}`, status: "succeeded", phase: "completed", finishedAt: index + 1 }),
    ),
  );
  store.merge([operation()]);
  store.merge([operation({ status: "succeeded", phase: "completed", finishedAt: 100 })]);
  expect(store.operations).toHaveLength(30);
  expect(store.operations.some((item) => item.requestId === "request")).toBe(true);
  expect(store.operations.some((item) => item.requestId === "old-0")).toBe(false);
});

it("focuses the modal and traps Tab at both boundaries", async () => {
  helmOperations.merge([operation()]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...props()} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(dialog);
  const minimize = screen.getByRole("button", { name: "Minimize" });
  minimize.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement?.tagName).toBe("SUMMARY");
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(minimize);
});

it("uses the native follow control, stable copy action, and both terminal footer actions", async () => {
  helmOperations.merge([
    operation({
      status: "succeeded",
      phase: "completed",
      finishedAt: Date.now(),
      logs: [{ at: Date.now(), message: "Complete" }],
    }),
  ]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...props()} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const dialog = screen.getByRole("dialog");
  const footer = dialog.querySelector(".power-helm-operation-footer")!;
  expect(footer.querySelectorAll("button")).toHaveLength(2);
  expect(footer.textContent).toContain("View history");
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  const details = dialog.querySelector("details")!;
  act(() => {
    details.open = true;
  });
  const checkbox = screen.getByRole("checkbox", { name: "Follow log" }) as HTMLInputElement;
  expect(checkbox.closest("[data-native-checkbox]")).toBeTruthy();
  expect(checkbox.checked).toBe(true);
  expect(getComputedStyle(checkbox).display).not.toBe("none");
  expect(getComputedStyle(checkbox).opacity).toBe("0");
  checkbox.focus();
  expect(document.activeElement).toBe(checkbox);
  expect(dialog.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  expect(checkbox.parentElement?.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);
  const copy = screen.getByRole("button", { name: "Copy log" });
  expect(copy.firstElementChild?.textContent).toBe("content_copy");
  fireEvent.click(copy);
  expect(screen.getByRole("button", { name: "Copy log" })).toBe(copy);
  expect(screen.getByRole("status").textContent).toBe("Copied");
  expect(mocks.copy).toHaveBeenCalledOnce();
});

it("times each explicit stage and freezes completed durations as phases advance", async () => {
  vi.setSystemTime(10_000);
  const stages = { preparing: { startedAt: 1000, finishedAt: 3000 }, applying: { startedAt: 3000 } };
  helmOperations.merge([operation({ phase: "applying", startedAt: 1000, stages })]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...props()} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const dialog = screen.getByRole("dialog");
  const rows = () => Array.from(dialog.querySelectorAll(".power-helm-operation-stages li"));
  expect(dialog.querySelector(".power-helm-operation-status")).toBeNull();
  expect(rows()[0].textContent).toContain("0m 2s");
  expect(rows()[1].textContent).toContain("0m 7s");
  expect(rows()[2].querySelector("small")).toBeNull();
  expect(dialog.querySelectorAll(".power-helm-operation-stage-progress")).toHaveLength(1);
  expect(rows()[1].lastElementChild?.getAttribute("role")).toBe("status");
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(rows()[1].textContent).toContain("0m 8s");
  act(() =>
    helmOperations.merge([
      operation({
        phase: "waiting",
        startedAt: 1000,
        stages: {
          ...stages,
          applying: { startedAt: 3000, finishedAt: 11_000 },
          waiting: { startedAt: 11_000 },
        },
      }),
    ]),
  );
  await act(async () => {
    vi.advanceTimersByTime(4000);
  });
  expect(rows()[0].textContent).toContain("0m 2s");
  expect(rows()[1].textContent).toContain("0m 8s");
  expect(rows()[2].textContent).toContain("0m 4s");
  act(() =>
    helmOperations.merge([
      operation({
        status: "succeeded",
        phase: "completed",
        startedAt: 1000,
        finishedAt: 16_000,
        stages: {
          ...stages,
          applying: { startedAt: 3000, finishedAt: 11_000 },
          waiting: { startedAt: 11_000, finishedAt: 16_000 },
        },
      }),
    ]),
  );
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(rows()[2].textContent).toContain("0m 5s");
  expect(dialog.querySelectorAll(".power-helm-operation-stage-progress")).toHaveLength(0);
});

it("marks the last started stage failed while leaving upcoming stages untimed", async () => {
  helmOperations.merge([
    operation({
      status: "failed",
      phase: "failed",
      finishedAt: 5000,
      stages: {
        preparing: { startedAt: 1000, finishedAt: 2000 },
        applying: { startedAt: 2000, finishedAt: 5000 },
      },
    }),
  ]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...props()} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const rows = Array.from(screen.getByRole("dialog").querySelectorAll(".power-helm-operation-stages li"));
  expect(rows[0].classList.contains("is-complete")).toBe(true);
  expect(rows[1].classList.contains("is-failed")).toBe(true);
  expect(rows[1].classList.contains("is-complete")).toBe(false);
  expect(rows[1].textContent).toContain("0m 3s");
  expect(rows[1].textContent).toContain("error");
  expect(rows[2].querySelector("small")).toBeNull();
});

it("displays local midnight with milliseconds while copying original ISO timestamps", async () => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
  const at = Date.UTC(2026, 0, 2, 10, 0, 0, 7);
  expect(new Date(at).getHours()).toBe(0);
  helmOperations.merge([
    operation({ status: "succeeded", phase: "completed", finishedAt: at, logs: [{ at, message: "Release applied" }] }),
  ]);
  helmOperations.open("request");
  render(<HelmOperationsPanel {...props()} />);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const expected = "00:00:00.007 Release applied";
  expect(screen.getByRole("dialog").querySelector("pre")?.textContent).toBe(expected);
  const details = screen.getByRole("dialog").querySelector("details")!;
  act(() => {
    details.open = true;
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  expect(mocks.copy).toHaveBeenCalledWith("2026-01-02T10:00:00.007Z Release applied");
});

it.each([
  "succeeded",
  "failed",
] as const)("closes a %s modal without history navigation or cancellation", async (status) => {
  const callbacks = props();
  helmOperations.merge([
    operation({ status, phase: status === "succeeded" ? "completed" : "failed", finishedAt: Date.now() }),
  ]);
  render(<HelmOperationsPanel {...callbacks} />);
  const progress = screen.getByRole("button", { name: "View progress" });
  progress.focus();
  fireEvent.click(progress);
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  const dialog = screen.getByRole("dialog");
  const footer = dialog.querySelector(".power-helm-operation-footer")!;
  const actions = Array.from(footer.querySelectorAll("button"));
  expect(actions).toHaveLength(2);
  expect(actions[0].textContent).toContain("View history");
  expect(actions[1].textContent).toContain("Close");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(progress);
  expect(callbacks.onViewHistory).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel")).toBe(false);
  expect(helmOperations.operations[0].status).toBe(status);
});

it("puts native icons before compact card action labels and keeps actions working", async () => {
  const callbacks = props();
  helmOperations.merge([operation({ status: "succeeded", phase: "completed", finishedAt: Date.now() })]);
  render(<HelmOperationsPanel {...callbacks} />);
  for (const [name, icon] of [
    ["View progress", "open_in_new"],
    ["View history", "history"],
    ["Dismiss", "close"],
  ]) {
    const button = screen.getByRole("button", { name });
    expect(button.firstElementChild?.textContent).toBe(icon);
    expect(button.lastElementChild?.textContent).toBe(name);
  }
  const bubbled = vi.fn();
  window.addEventListener("click", bubbled);
  try {
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(bubbled).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("click", bubbled);
  }
  expect(callbacks.onViewHistory).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request" }));
  fireEvent.click(screen.getByRole("button", { name: "View progress" }));
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("button", { name: "View progress" })).toBeNull();
});
