// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HELM_CHANNEL } from "../common/helm";
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
      Icon: ({ material }: any) => <span>{material}</span>,
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
      MenuItem: ({ children, disabled, onClick }: any) => (
        <button role="menuitem" disabled={disabled} onClick={onClick}>
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
beforeEach(() => {
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
  expect(dialog.labelOk).toBe("Delete release");
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
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(
    HELM_CHANNEL,
    expect.objectContaining({
      operation: "uninstall",
      confirmed: true,
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
  act(() => dialog.ok());
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
  act(() => dialog.ok());
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
  act(() => dialog.ok());
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
