// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
  error: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("./react-roots", () => ({ renderIntoContainer: mocks.render, unmountContainer: mocks.unmount }));
vi.mock("./cluster-icons", () => ({ IconEditor: () => null }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: {
      getClusterById: (id: string) => id === "sample",
      catalogCategories: { getForGroupKind: () => ({ on: mocks.on, off: mocks.off }) },
    },
    Component: { Icon: () => null, Notifications: { error: mocks.error } },
  },
}));

import { startClusterIconSettingsMenu } from "./cluster-icon-settings-menu";

afterEach(() => {
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

const setup = () => {
  document.body.innerHTML =
    '<button data-testid="icon-for-menu-actions-for-cluster-icon-settings-for-sample"></button><ul data-testid="menu-actions-for-cluster-icon-settings-for-sample"><li class="MenuItem">Upload Icon</li><li class="MenuItem disabled">Clear</li></ul>';
  return document.body.innerHTML;
};

it("opens the exact selected cluster with its saved design and restores the native menu on stop", async () => {
  const before = setup();
  const entry = { id: "sample", name: "Example", design: { label: "EX", outlineColor: "#123456" } };
  mocks.invoke.mockResolvedValue([entry]);
  const trigger = document.querySelector("button")!;
  const close = vi.fn();
  trigger.addEventListener("click", close);
  const stop = startClusterIconSettingsMenu();
  const edit = document.querySelector<HTMLButtonElement>('[aria-label="Edit icon"]')!;
  expect(edit).toBeTruthy();
  expect(document.querySelectorAll(".MenuItem")).toHaveLength(3);
  edit.click();
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(expect.any(String), { operation: "list" });
  expect(mocks.render.mock.calls.at(-1)?.[0].props.entry).toBe(entry);
  stop();
  expect(document.body.innerHTML).toBe(before);
});

it("does not open a late editor after the feature is disabled", async () => {
  setup();
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const stop = startClusterIconSettingsMenu();
  document.querySelector<HTMLButtonElement>('[aria-label="Edit icon"]')!.click();
  stop();
  const count = mocks.render.mock.calls.length;
  resolve([{ id: "sample", name: "Example" }]);
  await Promise.resolve();
  expect(mocks.render).toHaveBeenCalledTimes(count);
  expect(mocks.error).not.toHaveBeenCalled();
});

it("reaches the editor action with arrows, skips disabled Clear and activates with Enter", async () => {
  setup();
  const upload = document.querySelector<HTMLElement>(".MenuItem")!;
  upload.tabIndex = 0;
  mocks.invoke.mockResolvedValue([{ id: "sample", name: "Example" }]);
  const stop = startClusterIconSettingsMenu();
  const edit = document.querySelector<HTMLElement>('[aria-label="Edit icon"]')!;
  upload.focus();
  upload.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(edit);
  edit.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(upload);
  upload.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(edit);
  edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  stop();
});

it("adds Edit icon to the native cluster row menu and removes its subscription on stop", async () => {
  const stop = startClusterIconSettingsMenu();
  expect(mocks.on).toHaveBeenCalledWith("contextMenuOpen", expect.any(Function));
  const addMenu = mocks.on.mock.calls[0][1];
  const context = { menuItems: [] as { title: string; icon: string; onClick: () => void }[] };
  addMenu({ getId: () => "web-link" }, context);
  expect(context.menuItems).toHaveLength(0);
  addMenu({ getId: () => "sample" }, context);
  expect(context.menuItems).toHaveLength(1);
  expect(context.menuItems[0]).toMatchObject({ title: "Edit icon", icon: "palette" });
  const entry = { id: "sample", name: "Example" };
  mocks.invoke.mockResolvedValue([entry]);
  context.menuItems[0].onClick();
  await Promise.resolve();
  expect(mocks.render.mock.calls.at(-1)?.[0].props.entry).toBe(entry);
  stop();
  expect(mocks.off).toHaveBeenCalledWith("contextMenuOpen", addMenu);
  const count = mocks.invoke.mock.calls.length;
  context.menuItems[0].onClick();
  expect(mocks.invoke).toHaveBeenCalledTimes(count);
});
