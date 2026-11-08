// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  invoke: vi.fn(),
  readOnly: false,
  render: vi.fn(),
  unmount: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: state.invoke } }));
vi.mock("./react-roots", () => ({ renderIntoContainer: state.render, unmountContainer: state.unmount }));
vi.mock("./native-tooltip", () => ({ NativeTooltip: ({ children }: any) => children }));
vi.mock("./helm-code-view", () => ({
  HelmCodeView: ({ value, onChange, readOnly, ariaLabel }: any) => (
    <div className="monaco-editor">
      <textarea
        aria-label={ariaLabel}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  ),
}));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => ({ enabled: state.readOnly }) },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Dialog: ({ children, pinned, close, "data-testid": testId }: any) => {
        const [open, setOpen] = useState(true);
        return open ? (
          <div
            data-testid={testId}
            onClick={(event) => {
              if (!pinned && event.target === event.currentTarget) {
                setOpen(false);
                close();
              }
            }}
          >
            {children}
          </div>
        ) : null;
      },
      Button: ({ label, onClick, disabled }: any) => (
        <button type="button" onClick={onClick} disabled={disabled}>
          {label}
        </button>
      ),
      Icon: () => <span />,
    },
    Catalog: {
      getClusterById: (id: string) => (id === "example" ? { id } : undefined),
      catalogCategories: { getForGroupKind: () => ({ on: state.on, off: state.off }) },
    },
  },
}));

import { KubeconfigEditor, startKubeconfigEditorEntrypoints } from "./kubeconfig-editor";

const original = "apiVersion: v1\nkind: Config\n";
const revision = "a".repeat(64);
beforeEach(() => {
  state.readOnly = false;
  state.invoke.mockResolvedValue({ text: original, revision, readOnly: false });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  history.replaceState({}, "", "/");
});

it("loads kubeconfig and writes only after explicit Save with the original revision", async () => {
  render(<KubeconfigEditor clusterId="example" onClose={vi.fn()} />);
  const editor = await screen.findByRole("textbox", { name: "Kubeconfig YAML" });
  expect((editor as HTMLTextAreaElement).value).toBe(original);
  const next = original + "preferences: {}\n";
  fireEvent.change(editor, { target: { value: next } });
  expect(state.invoke).toHaveBeenCalledTimes(1);
  state.invoke.mockResolvedValueOnce({ text: next, revision: "b".repeat(64), readOnly: false });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(state.invoke).toHaveBeenLastCalledWith("freelens-power:kubeconfig-editor", {
    operation: "save",
    clusterId: "example",
    text: next,
    revision,
  });
});

it("preserves edits after a failed save and confirms before reloading or closing", async () => {
  const close = vi.fn();
  render(<KubeconfigEditor clusterId="example" onClose={close} />);
  const editor = await screen.findByRole("textbox", { name: "Kubeconfig YAML" });
  const next = original + "preferences: {}\n";
  fireEvent.change(editor, { target: { value: next } });
  state.invoke.mockRejectedValueOnce(new Error("filesystem detail"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect((editor as HTMLTextAreaElement).value).toBe(next);
  expect(screen.queryByText("filesystem detail")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByText("Discard unsaved changes?");
  expect(state.invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(original));
  expect(close).not.toHaveBeenCalled();
});

it("opens in read-only mode without enabling file writes", async () => {
  state.invoke.mockResolvedValue({ text: original, revision, readOnly: true });
  render(<KubeconfigEditor clusterId="example" onClose={vi.fn()} />);
  const editor = await screen.findByRole("textbox", { name: "Kubeconfig YAML" });
  expect((editor as HTMLTextAreaElement).readOnly).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

it("adds both native cluster menu action and settings icon and removes them on disable", () => {
  history.replaceState({}, "", "/entity/example/settings");
  document.body.innerHTML =
    '<div data-testid="entity-settings"><div class="SubTitle">Kubeconfig</div><a class="link value">config.yaml</a></div>';
  const before = document.body.innerHTML;
  const stop = startKubeconfigEditorEntrypoints();
  expect(document.querySelector("[data-power-kubeconfig-action]")).not.toBeNull();
  const context = { menuItems: [] as any[] };
  state.on.mock.calls[0][1]({ getId: () => "example" }, context);
  expect(context.menuItems[0].title).toBe("Open kubeconfig");
  context.menuItems[0].onClick();
  expect(state.render.mock.calls.at(-1)?.[0].props.clusterId).toBe("example");
  stop();
  expect(state.off).toHaveBeenCalled();
  expect(document.body.innerHTML).toBe(before);
});

it("keeps dirty editor visible on backdrop dismissal and lets Monaco handle Escape overlays first", async () => {
  const close = vi.fn();
  render(<KubeconfigEditor clusterId="example" onClose={close} />);
  const editor = await screen.findByRole("textbox", { name: "Kubeconfig YAML" });
  fireEvent.change(editor, { target: { value: original + "preferences: {}\n" } });
  fireEvent.click(screen.getByTestId("power-kubeconfig-editor-modal"));
  expect(screen.getByRole("textbox", { name: "Kubeconfig YAML" })).not.toBeNull();
  expect(screen.getByText("Discard unsaved changes?")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  const widget = document.createElement("div");
  widget.className = "find-widget visible";
  editor.closest(".monaco-editor")!.append(widget);
  const handled = vi.fn();
  editor.addEventListener("keydown", handled);
  fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
  expect(handled).toHaveBeenCalled();
  expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  widget.remove();
});
