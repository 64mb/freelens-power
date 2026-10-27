// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HELM_CHANNEL } from "../common/helm";
import { helmOperations } from "./helm-operations";
import { HelmReleaseActions } from "./helm-release-actions";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  readOnly: { enabled: false },
  power: { enabled: true },
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("./native-tooltip", () => ({ NativeTooltip: ({ children }: any) => children }));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => mocks.readOnly },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.power },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Icon: ({ material }: any) => <span aria-hidden="true">{material}</span>,
      Dialog: ({ children }: any) => <div>{children}</div>,
      Input: ({ value, onChange, onSubmit, trim: _trim, ...props }: any) => (
        <input
          {...props}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit?.(value, event);
          }}
        />
      ),
      Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
      Menu: ({ children, className, close }: any) => (
        <div
          role="menu"
          className={className}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          {children}
        </div>
      ),
      MenuItem: ({ children, disabled, onClick, className }: any) => (
        <button role="menuitem" className={className} disabled={disabled} onClick={onClick}>
          {children}
        </button>
      ),
      ConfirmDialog: { open: mocks.confirm },
    },
  },
}));
const release = {
  name: "example",
  namespace: "default",
  revision: 2,
  uid: "release-two",
  secretName: "secret",
  status: "deployed",
};
const props = () => ({
  clusterId: "cluster",
  contextId: "context",
  release,
  allowed: true,
  onDeleted: vi.fn(),
  onChanged: vi.fn(),
  onError: vi.fn(),
});
const open = () => {
  fireEvent.click(screen.getByLabelText("Release actions"));
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  fireEvent.click(screen.getByRole("menuitem", { name: /Delete release/ }));
  return mocks.confirm.mock.calls.at(-1)?.[0];
};
const confirmName = async (dialog: any) => {
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: release.name } });
  fireEvent.click(screen.getByRole("button", { name: "Delete release" }));
};
beforeEach(() => {
  helmOperations.operations = [];
  vi.clearAllMocks();
  mocks.readOnly = observable({ enabled: false });
  mocks.power = observable({ enabled: true });
  mocks.invoke.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
it("shows only delete and waits for explicit confirmation", () => {
  render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  const label = render(dialog.labelOk);
  expect(label.container.firstElementChild?.textContent).toBe("delete");
  expect(label.getByText("Delete release")).toBeTruthy();
  label.unmount();
  const message = render(dialog.message);
  expect(message.getByText("Delete release example?")).toBeTruthy();
  expect(message.getByText("default")).toBeTruthy();
  expect(message.getByText(/Helm uninstall/)).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it.each([
  { contextId: "new-context" },
  { clusterId: "new-cluster" },
  { release: { ...release, uid: "replacement" } },
  { release: { ...release, revision: 3 } },
  { release: { ...release, namespace: "other" } },
  { allowed: false },
])("rejects stale confirmation after target or permission changes: %j", (patch) => {
  const initial = props();
  const view = render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  view.rerender(<HelmReleaseActions {...initial} {...patch} />);
  act(() => dialog.ok());
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it.each(["readOnly", "power"] as const)("reacts to %s changes and rechecks open confirmations", (store) => {
  render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  act(() =>
    runInAction(() => {
      mocks[store].enabled = store === "readOnly";
    }),
  );
  act(() => dialog.ok());
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Release actions")).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
});
it.each([
  { contextId: undefined },
  { allowed: false },
  { release: { ...release, uid: undefined } },
])("disables deletion without required context or permission: %j", (patch) => {
  render(<HelmReleaseActions {...props()} {...patch} />);
  fireEvent.click(screen.getByLabelText("Release actions"));
  expect((screen.getByRole("menuitem") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem"));
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("sends one confirmed uninstall and closes and refreshes after success", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const initial = props();
  render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  act(() => {
    dialog.ok();
    dialog.ok();
  });
  expect(mocks.invoke).not.toHaveBeenCalled();
  await confirmName(dialog);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(
    HELM_CHANNEL,
    expect.objectContaining({
      operation: "uninstall",
      confirmed: true,
      confirmationName: "example",
      clusterId: "cluster",
      contextId: "context",
      name: "example",
      namespace: "default",
      revision: 2,
      uid: "release-two",
    }),
  );
  fireEvent.click(screen.getByLabelText("Release actions"));
  expect((screen.getByRole("menuitem") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve({ ok: true }));
  act(() => dialog.ok());
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(initial.onDeleted).toHaveBeenCalledOnce();
  expect(initial.onChanged).toHaveBeenCalledOnce();
  expect(initial.onError).not.toHaveBeenCalled();
});
it.each([false, true])("reports backend or IPC errors without closing: rejected=%j", async (rejected) => {
  if (rejected) mocks.invoke.mockRejectedValue(new Error("Unavailable"));
  else mocks.invoke.mockResolvedValue({ ok: false, error: { code: "stale-revision", message: "Release changed" } });
  const initial = props();
  render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  await confirmName(dialog);
  await waitFor(() => expect(initial.onError).toHaveBeenCalledWith(rejected ? "Unavailable" : "Release changed"));
  expect(initial.onDeleted).not.toHaveBeenCalled();
  expect(initial.onChanged).not.toHaveBeenCalled();
});
it("cancels the active IPC request on unmount and ignores late completion", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel"
      ? Promise.resolve({ ok: true })
      : new Promise((done) => {
          resolve = done;
        }),
  );
  const initial = props();
  const view = render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  await confirmName(dialog);
  const request = mocks.invoke.mock.calls[0][1];
  view.unmount();
  expect(mocks.invoke).toHaveBeenLastCalledWith(HELM_CHANNEL, { ...request, operation: "cancel" });
  await act(async () => resolve({ ok: true }));
  act(() => dialog.ok());
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(initial.onDeleted).not.toHaveBeenCalled();
  expect(initial.onChanged).not.toHaveBeenCalled();
});
it("ignores a completion belonging to another release", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const initial = props();
  const view = render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  await confirmName(dialog);
  view.rerender(<HelmReleaseActions {...initial} release={{ ...release, uid: "replacement" }} />);
  await act(async () => resolve({ ok: true }));
  expect(initial.onDeleted).not.toHaveBeenCalled();
  expect(initial.onChanged).not.toHaveBeenCalled();
});

it("returns focus to the trigger when the native menu closes with Escape", () => {
  render(<HelmReleaseActions {...props()} />);
  const trigger = screen.getByLabelText("Release actions");
  fireEvent.click(trigger);
  const item = screen.getByRole("menuitem");
  item.focus();
  expect(document.activeElement).toBe(item);
  fireEvent.keyDown(item, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("focuses the connected trigger before opening the confirmation dialog", () => {
  render(<HelmReleaseActions {...props()} />);
  const trigger = screen.getByLabelText("Release actions");
  fireEvent.click(trigger);
  const item = screen.getByRole("menuitem");
  item.focus();
  mocks.confirm.mockImplementationOnce(() => {
    expect(document.activeElement).toBe(trigger);
    expect(trigger.isConnected).toBe(true);
  });
  fireEvent.click(item);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("blocks deleting the matching active rollback while leaving another release available", () => {
  const initial = props();
  const view = render(<HelmReleaseActions {...initial} />);
  act(() =>
    helmOperations.merge([
      {
        id: "active",
        requestId: "active",
        clusterId: initial.clusterId,
        contextId: initial.contextId,
        namespace: release.namespace,
        name: release.name,
        revision: 1,
        status: "running",
        phase: "waiting",
        startedAt: Date.now(),
        logs: [],
      },
    ]),
  );
  fireEvent.click(screen.getByLabelText("Release actions"));
  expect((screen.getByRole("menuitem") as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<HelmReleaseActions {...initial} release={{ ...release, name: "another" }} />);
  expect((screen.getByRole("menuitem") as HTMLButtonElement).disabled).toBe(false);
});

it("opens the typed confirmation only after the first native dialog closes", async () => {
  render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  act(() => dialog.ok());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  const input = await screen.findByRole("textbox", { name: "Release name" });
  expect(document.activeElement).toBe(input);
  expect(screen.getByTestId("confirmation-dialog")).toBe(screen.getByRole("dialog"));
  expect((screen.getByRole("button", { name: "Delete release" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([
  "Example",
  " example",
  "example ",
  "another",
])("requires the exact release name, rejecting %j", async (name) => {
  render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: name } });
  const submit = screen.getByRole("button", { name: "Delete release" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(submit);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("cancels typed confirmation without uninstalling and restores trigger focus", async () => {
  render(<HelmReleaseActions {...props()} />);
  const trigger = screen.getByLabelText("Release actions");
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: release.name } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([
  { contextId: "changed-context" },
  { release: { ...release, uid: "new-uid" } },
  { allowed: false },
])("blocks typed confirmation after identity or permission changes: %j", async (patch) => {
  const initial = props();
  const view = render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: release.name } });
  view.rerender(<HelmReleaseActions {...initial} {...patch} />);
  expect((screen.getByRole("button", { name: "Delete release" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("rechecks a new rollback lock before typed confirmation submits", async () => {
  const initial = props();
  render(<HelmReleaseActions {...initial} />);
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: release.name } });
  act(() =>
    helmOperations.merge([
      {
        id: "lock",
        requestId: "lock",
        clusterId: initial.clusterId,
        contextId: initial.contextId,
        namespace: release.namespace,
        name: release.name,
        revision: 1,
        status: "running",
        phase: "waiting",
        startedAt: Date.now(),
        logs: [],
      },
    ]),
  );
  expect((screen.getByRole("button", { name: "Delete release" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("closes typed confirmation when read-only mode becomes enabled", async () => {
  render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.change(input, { target: { value: release.name } });
  act(() =>
    runInAction(() => {
      mocks.readOnly.enabled = true;
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("traps typed-dialog focus and cancels with Escape without closing its parent", async () => {
  render(<HelmReleaseActions {...props()} />);
  const trigger = screen.getByLabelText("Release actions");
  const dialog = open();
  act(() => dialog.ok());
  const input = await screen.findByRole("textbox", { name: "Release name" });
  fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: release.name } });
  const submit = screen.getByRole("button", { name: "Delete release" });
  submit.focus();
  fireEvent.keyDown(submit, { key: "Tab" });
  expect(document.activeElement).toBe(input);
  const underlying = vi.fn();
  document.addEventListener("keydown", underlying);
  fireEvent.keyDown(input, { key: "Escape" });
  document.removeEventListener("keydown", underlying);
  expect(underlying).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("cleans up the deferred second dialog when its owner unmounts", () => {
  vi.useFakeTimers();
  const view = render(<HelmReleaseActions {...props()} />);
  const dialog = open();
  act(() => dialog.ok());
  view.unmount();
  act(() => {
    vi.runAllTimers();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
