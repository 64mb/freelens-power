// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://cluster.renderer.freelens.app"}
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NODE_BULK_CHANNEL } from "../common/node-bulk";

import type { NodeBulkJob } from "../common/node-bulk";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  loadAll: vi.fn(),
  cluster: { metadata: { uid: "cluster" }, spec: { kubeconfigContext: "context-a" } },
  power: { enabled: true },
  readOnly: { enabled: false },
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", async () => {
  const { useState, cloneElement } = await import("react");
  return {
    Renderer: {
      Catalog: { activeCluster: { get: () => mocks.cluster } },
      K8sApi: { nodesStore: { loadAll: mocks.loadAll } },
      Component: {
        Button: ({ children, ...props }: import("react").ButtonHTMLAttributes<HTMLButtonElement>) => (
          <button {...props}>{children}</button>
        ),
        MenuActions: ({
          triggerIcon,
          children,
        }: {
          triggerIcon: import("react").ReactElement;
          children: import("react").ReactNode;
        }) => {
          const [open, setOpen] = useState(false);
          return (
            <>
              {cloneElement(triggerIcon, { onClick: () => setOpen(!open) })}
              {open && (
                <div role="menu" onClick={() => setOpen(false)}>
                  {children}
                </div>
              )}
            </>
          );
        },
        MenuItem: ({ children, ...props }: import("react").ButtonHTMLAttributes<HTMLButtonElement>) => (
          <button role="menuitem" {...props}>
            {children}
          </button>
        ),
        Icon: () => <i />,
        ConfirmDialog: { open: mocks.confirm },
      },
    },
  };
});
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.power },
}));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => mocks.readOnly },
}));
vi.mock("./native-tooltip", () => ({
  NativeTooltip: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
}));

import { NodeBulkToolbar } from "./node-bulk-actions";

const selected = [
  { uid: "node-uid-a", name: "node-a" },
  { uid: "node-uid-b", name: "node-b" },
];
const scope = JSON.stringify(["cluster", "context-a"]);
const job = (status: NodeBulkJob["status"] = "running"): NodeBulkJob => ({
  id: "job-a",
  clusterId: "cluster",
  contextId: "authorization-a",
  action: "cordon",
  status,
  nodes: selected.map((node) => ({ ...node, status: status === "running" ? "pending" : status })),
  startedAt: Date.now(),
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const confirmation = () =>
  mocks.confirm.mock.calls.at(-1)![0] as { ok: () => Promise<void>; message: import("react").ReactElement };
const clickAction = (action: "Cordon" | "Uncordon" | "Drain") => {
  fireEvent.click(screen.getByRole("button", { name: /Actions for \d+ selected nodes/ }));
  const item = screen.queryByRole("menuitem", { name: action });
  if (item) fireEvent.click(item);
};
const setup = () => {
  const onClear = vi.fn();
  return {
    ...render(<NodeBulkToolbar clusterId="cluster" scope={scope} selected={selected} onClear={onClear} />),
    onClear,
  };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cluster.spec.kubeconfigContext = "context-a";
  mocks.power.enabled = true;
  mocks.readOnly.enabled = false;
  mocks.loadAll.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (_channel, request) =>
    request.operation === "context" ? { ok: true, contextId: "authorization-a" } : { ok: true, job: job() },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("requests context only on action and confirms the exact node list before beginning", async () => {
  setup();
  expect(mocks.invoke).not.toHaveBeenCalled();
  clickAction("Cordon");
  await flush();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(NODE_BULK_CHANNEL, {
    clusterId: "cluster",
    operation: "context",
  });
  const dialog = confirmation();
  const preview = render(dialog.message);
  expect(preview.getByText("node-a")).toBeTruthy();
  expect(preview.getByText("node-b")).toBeTruthy();
  await act(async () => {
    await dialog.ok();
  });
  expect(mocks.invoke).toHaveBeenLastCalledWith(NODE_BULK_CHANNEL, {
    clusterId: "cluster",
    operation: "begin",
    contextId: "authorization-a",
    action: "cordon",
    nodes: selected,
    confirmed: true,
  });
  expect(screen.getByRole("status").textContent).toContain("running");
});

it.each(["selection", "context"])("rejects confirmation when %s changes", async (change) => {
  const view = setup();
  clickAction("Drain");
  await flush();
  const dialog = confirmation();
  if (change === "context") mocks.cluster.spec.kubeconfigContext = "context-b";
  else
    view.rerender(
      <NodeBulkToolbar clusterId="cluster" scope={scope} selected={[selected[0]]} onClear={view.onClear} />,
    );
  await act(async () => {
    await dialog.ok();
  });
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "begin")).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain("changed");
});

it.each(["power", "readOnly"])("blocks mutations while %s guard is active", async (guard) => {
  setup();
  if (guard === "power") mocks.power.enabled = false;
  else mocks.readOnly.enabled = true;
  clickAction("Cordon");
  await flush();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it("polls running progress, displays results, and refreshes after completion", async () => {
  vi.useFakeTimers();
  const view = setup();
  clickAction("Cordon");
  await flush();
  await act(async () => {
    await confirmation().ok();
  });
  const completed = job("succeeded");
  mocks.invoke.mockResolvedValue({ ok: true, job: completed });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
  });
  expect(screen.getByRole("status").textContent).toContain("2 / 2 completed");
  expect(view.onClear).toHaveBeenCalledOnce();
  expect(mocks.loadAll).toHaveBeenCalledOnce();
});

it("hides raw IPC errors when preparation fails", async () => {
  setup();
  mocks.invoke.mockRejectedValue(new Error("private endpoint and token"));
  clickAction("Cordon");
  await flush();
  expect(screen.getByRole("alert").textContent).not.toContain("private endpoint");
  expect(screen.getByRole("alert").textContent).toContain("unavailable");
});

it("cancels a job returned after the toolbar was unmounted", async () => {
  const view = setup();
  clickAction("Cordon");
  await flush();
  let resolveBegin!: (response: object) => void;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "begin"
      ? new Promise((resolve) => {
          resolveBegin = resolve;
        })
      : Promise.resolve({ ok: true, job: job("cancelled") }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = confirmation().ok();
  });
  view.unmount();
  await act(async () => {
    resolveBegin({ ok: true, job: job() });
    await pending;
  });
  expect(mocks.invoke).toHaveBeenLastCalledWith(NODE_BULK_CHANNEL, {
    clusterId: "cluster",
    operation: "cancel",
    contextId: "authorization-a",
    jobId: "job-a",
  });
});

it("cancels running work explicitly", async () => {
  setup();
  clickAction("Cordon");
  await flush();
  await act(async () => {
    await confirmation().ok();
  });
  mocks.invoke.mockResolvedValue({ ok: true, job: job("cancelled") });
  fireEvent.click(screen.getByRole("button", { name: "Cancel remaining" }));
  await flush();
  expect(mocks.invoke).toHaveBeenLastCalledWith(NODE_BULK_CHANNEL, {
    clusterId: "cluster",
    operation: "cancel",
    contextId: "authorization-a",
    jobId: "job-a",
  });
  expect(screen.getByRole("status").textContent).toContain("cancelled");
});

it("opens one confirmation for repeated action clicks and begins once for repeated confirmation", async () => {
  setup();
  let resolveContext!: (response: object) => void;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "context"
      ? new Promise((resolve) => {
          resolveContext = resolve;
        })
      : new Promise(() => {}),
  );
  clickAction("Cordon");
  clickAction("Cordon");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveContext({ ok: true, contextId: "authorization-a" });
  });
  expect(mocks.confirm).toHaveBeenCalledOnce();
  act(() => {
    void confirmation().ok();
    void confirmation().ok();
  });
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "begin")).toHaveLength(1);
});

it.each(["power", "readOnly"])("rejects an open confirmation after %s changes", async (guard) => {
  setup();
  clickAction("Cordon");
  await flush();
  if (guard === "power") mocks.power.enabled = false;
  else mocks.readOnly.enabled = true;
  await act(async () => {
    await confirmation().ok();
  });
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "begin")).toHaveLength(0);
});

it("cancels running work when the toolbar unmounts", async () => {
  const view = setup();
  clickAction("Cordon");
  await flush();
  await act(async () => {
    await confirmation().ok();
  });
  mocks.invoke.mockResolvedValue({ ok: true, job: job("cancelled") });
  view.unmount();
  await flush();
  expect(mocks.invoke).toHaveBeenLastCalledWith(NODE_BULK_CHANNEL, {
    clusterId: "cluster",
    operation: "cancel",
    contextId: "authorization-a",
    jobId: "job-a",
  });
});

it("shows a safe start failure without backend error details", async () => {
  setup();
  clickAction("Cordon");
  await flush();
  mocks.invoke.mockResolvedValue({ ok: false, error: { code: "internal", message: "sensitive transport details" } });
  await act(async () => {
    await confirmation().ok();
  });
  expect(screen.getByRole("alert").textContent).toContain("Unable to start");
  expect(document.body.textContent).not.toContain("sensitive transport details");
});

it("shows a floating actions trigger only when nodes are selected", () => {
  const onClear = vi.fn();
  const view = render(<NodeBulkToolbar clusterId="cluster" scope={scope} selected={[]} onClear={onClear} />);
  expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  view.rerender(<NodeBulkToolbar clusterId="cluster" scope={scope} selected={selected} onClear={onClear} />);
  const trigger = screen.getByRole("button", { name: "Actions for 2 selected nodes" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.classList.contains("power-node-bulk-fab")).toBe(true);
  expect(screen.queryByRole("menuitem", { name: "Cordon" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cordon" })).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByRole("menuitem", { name: "Cordon" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Uncordon" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Drain" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear selection" }));
  expect(onClear).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
