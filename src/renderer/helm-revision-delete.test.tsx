// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HELM_CHANNEL } from "../common/helm";
import { HelmRevisionDelete, type HelmRevisionDeleteProps } from "./helm-revision-delete";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  readOnly: { enabled: false },
  power: { enabled: true },
  running: false,
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("./native-tooltip", () => ({ NativeTooltip: ({ children }: any) => children }));
vi.mock("./helm-operations", () => ({ helmOperations: { isRunning: () => mocks.running } }));
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
      ConfirmDialog: { open: mocks.confirm },
    },
  },
}));
const props = (): HelmRevisionDeleteProps => ({
  clusterId: "cluster",
  contextId: "context",
  revision: {
    name: "example",
    namespace: "default",
    revision: 2,
    status: "superseded",
    uid: "revision-two",
    secretName: "revision-secret",
  },
  current: false,
  allowed: true,
  onDeleted: vi.fn(),
  onError: vi.fn(),
});
const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "Delete revision 2" }));
  return mocks.confirm.mock.calls.at(-1)![0];
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.running = false;
  mocks.readOnly = observable({ enabled: false });
  mocks.power = observable({ enabled: true });
  mocks.invoke.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it("describes history-only deletion and sends nothing until confirmed", () => {
  render(<HelmRevisionDelete {...props()} />);
  const dialog = open();
  const label = render(dialog.labelOk);
  expect(label.getByText("Delete revision 2")).toBeTruthy();
  expect(label.container.querySelector('[aria-hidden="true"]')?.textContent).toBe("delete");
  const message = render(dialog.message);
  expect(message.getByText("Delete revision 2 from history?")).toBeTruthy();
  expect(message.container.textContent).toContain("active release and its Kubernetes resources are preserved");
  expect(message.container.textContent).toContain("example");
  expect(message.container.textContent).not.toContain("uninstall");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("hides the delete action in read-only mode", () => {
  mocks.readOnly.enabled = true;
  render(<HelmRevisionDelete {...props()} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it.each([
  "deployed",
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
  "unknown",
])("disables deleting a %s revision", (status) => {
  const initial = props();
  render(<HelmRevisionDelete {...initial} revision={{ ...initial.revision, status }} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button"));
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it.each([
  { current: true },
  { allowed: false },
  { busy: true },
  { contextId: undefined },
])("disables unavailable historical revisions: %j", (overrides) => {
  render(<HelmRevisionDelete {...props()} {...overrides} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});

it("rejects confirmation after the cluster context changes", () => {
  const initial = props();
  const view = render(<HelmRevisionDelete {...initial} />);
  const dialog = open();
  view.rerender(<HelmRevisionDelete {...initial} contextId="another-context" />);
  act(() => dialog.ok());
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each(["readOnly", "power", "running"] as const)("rechecks %s after confirmation opens", (guard) => {
  render(<HelmRevisionDelete {...props()} />);
  const dialog = open();
  act(() =>
    runInAction(() => {
      if (guard === "running") mocks.running = true;
      else if (guard === "readOnly") mocks.readOnly.enabled = true;
      else mocks.power.enabled = false;
    }),
  );
  act(() => dialog.ok());
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("sends the selected revision UID and refreshes history once after success", async () => {
  const initial = props();
  render(<HelmRevisionDelete {...initial} />);
  const dialog = open();
  await act(async () => {
    dialog.ok();
    dialog.ok();
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(
    HELM_CHANNEL,
    expect.objectContaining({
      operation: "delete-revision",
      clusterId: initial.clusterId,
      contextId: initial.contextId,
      namespace: "default",
      name: "example",
      revision: 2,
      uid: "revision-two",
      confirmed: true,
    }),
  );
  expect(initial.onDeleted).toHaveBeenCalledOnce();
  expect(initial.onError).not.toHaveBeenCalled();
});

it("surfaces the backend failure without refreshing history", async () => {
  mocks.invoke.mockResolvedValue({ ok: false, error: { code: "REVISION_ACTIVE", message: "Revision is active" } });
  const initial = props();
  render(<HelmRevisionDelete {...initial} />);
  const dialog = open();
  await act(async () => dialog.ok());
  expect(initial.onError).toHaveBeenCalledWith("Revision is active");
  expect(initial.onDeleted).not.toHaveBeenCalled();
});

it("cancels an unmounted request and ignores its late response", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel"
      ? Promise.resolve()
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const initial = props();
  const view = render(<HelmRevisionDelete {...initial} />);
  act(() => open().ok());
  const payload = mocks.invoke.mock.calls[0][1];
  view.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith(HELM_CHANNEL, { ...payload, operation: "cancel" });
  await act(async () => finish({ ok: true }));
  expect(initial.onDeleted).not.toHaveBeenCalled();
  expect(initial.onError).not.toHaveBeenCalled();
});
