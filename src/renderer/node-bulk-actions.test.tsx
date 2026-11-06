// @vitest-environment jsdom

vi.mock("./react-roots", async () => import("./react-roots.test-utils"));

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
  power: { enabled: true, nodeBulkActions: true },
  readOnly: { enabled: false },
}));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("@freelensapp/extensions", async () => {
  const { MockTooltip } = await import("./native-tooltip.test-utils");
  return {
    Renderer: {
      Catalog: { activeCluster: { get: () => mocks.cluster } },
      K8sApi: {
        nodesStore: { loadAll: mocks.loadAll, contextItems: [{ getId: () => "node-uid-a", getName: () => "node-a" }] },
      },
      Component: {
        Button: ({ children, ...props }: import("react").ButtonHTMLAttributes<HTMLButtonElement>) => (
          <button {...props}>{children}</button>
        ),
        MenuActions: () => {
          throw new Error("native MenuActions requires host DI context");
        },
        MenuItem: () => {
          throw new Error("native MenuItem requires host menu context");
        },
        Icon: () => {
          throw new Error("native Icon requires host DI context");
        },
        Tooltip: MockTooltip,
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

import { tooltipText } from "./native-tooltip.test-utils";
import { NodeBulkToolbar, startNodeBulkActions } from "./node-bulk-actions";

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
  mocks.confirm.mock.calls.at(-1)![0] as {
    ok: () => Promise<void>;
    message: import("react").ReactElement;
    labelOk: import("react").ReactElement;
    okButtonProps?: { className: string };
  };
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
  mocks.power.nodeBulkActions = true;
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

it.each([
  ["Cordon", "pause_circle_filled"],
  ["Uncordon", "play_circle_filled"],
  ["Drain", "delete_sweep"],
] as const)("shows the %s confirmation icon and selected nodes", async (action, icon) => {
  setup();
  clickAction(action);
  await flush();
  const dialog = confirmation();
  expect(dialog.okButtonProps?.className).toBe(action === "Drain" ? "power-node-bulk-destructive" : undefined);
  const label = render(<button type="button">{dialog.labelOk}</button>);
  expect(label.getByRole("button", { name: `${action} 2 nodes` }).querySelector(".icon")?.textContent).toBe(icon);
  const preview = render(dialog.message);
  expect(preview.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["node-a", "node-b"]);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "begin")).toHaveLength(0);
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

it.each(["power", "readOnly", "nodeBulkActions"])("blocks mutations while %s guard is active", async (guard) => {
  setup();
  if (guard === "power") mocks.power.enabled = false;
  else if (guard === "nodeBulkActions") mocks.power.nodeBulkActions = false;
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

it.each(["power", "readOnly", "nodeBulkActions"])("rejects an open confirmation after %s changes", async (guard) => {
  setup();
  clickAction("Cordon");
  await flush();
  if (guard === "power") mocks.power.enabled = false;
  else if (guard === "nodeBulkActions") mocks.power.nodeBulkActions = false;
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
  expect(tooltipText(trigger)).toBe("Actions for selected nodes (2)");
  expect(trigger.getAttribute("title")).toBeNull();
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.classList.contains("power-node-bulk-fab")).toBe(true);
  expect(screen.queryByRole("menuitem", { name: "Cordon" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cordon" })).toBeNull();
  fireEvent.click(trigger);
  expect(tooltipText(trigger)).toBe("");
  expect(screen.getByRole("menuitem", { name: "Cordon" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Uncordon" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Drain" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear selection" }));
  expect(onClear).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("supports standalone selection and menu without host dependency injection", async () => {
  const fixture = document.createElement("div");
  fixture.innerHTML =
    '<div class="Nodes"><div class="Table"><div class="TableHead"></div><div class="TableRow" id="menu-actions-for-kube-object-menu-for-node-uid-a"></div></div></div>';
  document.body.append(fixture);
  let stop!: () => void;
  act(() => {
    stop = startNodeBulkActions();
  });
  try {
    fireEvent.click(fixture.querySelector<HTMLInputElement>('.TableRow input[type="checkbox"]')!);
    await flush();
    const trigger = screen.getByRole("button", { name: "Actions for 1 selected nodes" });
    expect(trigger.querySelector(".Icon.material .icon")?.textContent).toBe("more_horiz");
    fireEvent.click(trigger);
    const cordon = screen.getByRole("menuitem", { name: "Cordon" });
    expect(cordon.querySelector(".Icon.material .icon")?.textContent).toBe("pause_circle_filled");
    expect(screen.getByRole("menuitem", { name: "Drain" }).querySelector(".icon")?.textContent).toBe("delete_sweep");
    fireEvent.click(cordon);
    await flush();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(NODE_BULK_CHANNEL, {
      clusterId: "cluster",
      operation: "context",
    });
  } finally {
    act(() => stop());
    fixture.remove();
  }
});

it("supports menu keyboard navigation, escape focus return and outside dismissal", () => {
  setup();
  const trigger = screen.getByRole("button", { name: "Actions for 2 selected nodes" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const cordon = screen.getByRole("menuitem", { name: "Cordon" });
  expect(document.activeElement).toBe(cordon);
  fireEvent.keyDown(cordon, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Uncordon" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Clear selection" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(cordon);
  fireEvent.keyDown(cordon, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("skips disabled menu actions and removes its portal on unmount", () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ uid: `uid-${index}`, name: `node-${index}` }));
  const view = render(<NodeBulkToolbar clusterId="cluster" scope={scope} selected={many} onClear={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Actions for 101 selected nodes" }));
  const cordon = screen.getByRole("menuitem", { name: "Cordon" }) as HTMLButtonElement;
  expect(cordon.disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Clear selection" }));
  fireEvent.click(cordon);
  expect(mocks.invoke).not.toHaveBeenCalled();
  view.unmount();
  expect(screen.queryByRole("menu")).toBeNull();
});
