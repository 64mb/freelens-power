// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn(), count: 2, shortcuts: true }));
vi.mock("./react-roots", () => ({ renderIntoContainer: roots.render, unmountContainer: roots.unmount }));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: {
    getInstanceOrCreate: () => ({
      get hotbarShortcuts() {
        return roots.shortcuts;
      },
    }),
  },
}));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: () => Promise.resolve(roots.count) } }));
vi.mock("./native-tooltip", () => ({ NativeTooltip: () => null }));

import { startHotbarName } from "./hotbar-name";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  roots.count = 2;
  roots.shortcuts = true;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("labels the active hotbar and updates after switching or renaming without changing native controls", async () => {
  document.body.innerHTML =
    '<div class="HotbarMenu"><div class="hotbar-selector-module__HotbarSelector--sample"><span data-testid="hotbar-menu-badge-for-Example">1</span></div></div>';
  const before = document.body.innerHTML;
  const stop = startHotbarName();
  await Promise.resolve();
  const host = document.querySelector("[data-power-hotbar-name]");
  expect(host?.nextElementSibling?.className).toContain("HotbarSelector");
  expect(roots.render.mock.calls.at(-1)?.[0].props.title).toBe("Example");
  const badge = document.querySelector<HTMLElement>("[data-testid]")!;
  badge.dataset.testid = "hotbar-menu-badge-for-Second panel";
  await Promise.resolve();
  expect(roots.render.mock.calls.at(-1)?.[0].props.title).toBe("Second panel");
  expect(document.querySelectorAll("[data-power-hotbar-name]")).toHaveLength(1);
  badge.dataset.testid = "hotbar-menu-badge-for-Example";
  await Promise.resolve();
  stop();
  expect(roots.unmount).toHaveBeenCalledExactlyOnceWith(host);
  expect(document.body.innerHTML).toBe(before);
});

it("hides the badge for a single hotbar and updates when hotbars are added or removed", async () => {
  vi.useFakeTimers();
  roots.count = 1;
  document.body.innerHTML =
    '<div class="HotbarMenu"><div class="hotbar-selector-module__HotbarSelector--sample"><span data-testid="hotbar-menu-badge-for-Example">1</span></div></div>';
  const stop = startHotbarName();
  await Promise.resolve();
  expect(document.querySelector("[data-power-hotbar-name]")).toBeNull();
  roots.count = 2;
  await vi.advanceTimersByTimeAsync(2000);
  expect(document.querySelector("[data-power-hotbar-name]")).not.toBeNull();
  roots.count = 1;
  await vi.advanceTimersByTimeAsync(2000);
  expect(document.querySelector("[data-power-hotbar-name]")).toBeNull();
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("switches hotbars with Cmd digits through native arrows while preserving input and modal shortcuts", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  document.body.innerHTML =
    '<div class="HotbarMenu"><div class="hotbar-selector-module__HotbarSelector--sample"><button class="Icon"></button><span data-testid="hotbar-menu-badge-for-Example">1</span><button class="Icon"></button></div></div><input><div class="monaco-editor" tabindex="0"></div>';
  const arrows = document.querySelectorAll<HTMLButtonElement>(".Icon");
  const next = vi.fn();
  arrows[1].addEventListener("click", next);
  const stop = startHotbarName();
  await Promise.resolve();
  const key = (target: Element | Document, code = "Digit2", extra = {}) => {
    const event = new KeyboardEvent("keydown", { code, metaKey: true, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  expect(key(document).defaultPrevented).toBe(true);
  expect(next).toHaveBeenCalledTimes(1);
  expect(key(document, "Digit9").defaultPrevented).toBe(false);
  expect(key(document, "Digit2", { altKey: true }).defaultPrevented).toBe(false);
  expect(key(document.querySelector("input")!).defaultPrevented).toBe(false);
  expect(key(document.querySelector(".monaco-editor")!).defaultPrevented).toBe(false);
  const modal = document.createElement("div");
  modal.className = "Dialog modal";
  document.body.append(modal);
  expect(key(document).defaultPrevented).toBe(false);
  modal.remove();
  roots.shortcuts = false;
  expect(key(document).defaultPrevented).toBe(false);
  stop();
  expect(key(document).defaultPrevented).toBe(false);
  expect(next).toHaveBeenCalledTimes(1);
});

it.each([
  ["MacIntel", { metaKey: true }],
  ["Win32", { ctrlKey: true }],
])("allows hotbar shortcuts only from native Catalog header search on %s", async (platform, modifier) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  document.body.innerHTML =
    '<div class="HotbarMenu"><div class="HotbarSelector"><button class="Icon"></button><span data-testid="hotbar-menu-badge-for-Example">1</span><button class="Icon"></button></div></div><main data-testid="catalog-list-for-General"><div class="header"><div class="SearchInput"><input value="example"></div></div><div class="SearchInput"><input id="row-input"></div></main><section><div class="header"><div class="SearchInput"><input id="other-search"></div></div></section>';
  const next = vi.fn();
  document.querySelectorAll(".Icon")[1].addEventListener("click", next);
  const stop = startHotbarName();
  await Promise.resolve();
  const input = document.querySelector<HTMLInputElement>("main > .header input")!;
  input.focus();
  const key = (target: Element) => {
    const event = new KeyboardEvent("keydown", { code: "Digit2", bubbles: true, cancelable: true, ...modifier });
    target.dispatchEvent(event);
    return event;
  };
  expect(key(input).defaultPrevented).toBe(true);
  expect(next).toHaveBeenCalledTimes(1);
  expect(input.value).toBe("example");
  expect(key(document.getElementById("row-input")!).defaultPrevented).toBe(false);
  expect(key(document.getElementById("other-search")!).defaultPrevented).toBe(false);
  const modal = document.createElement("div");
  modal.className = "Dialog modal";
  document.body.append(modal);
  expect(key(input).defaultPrevented).toBe(false);
  modal.remove();
  roots.shortcuts = false;
  expect(key(input).defaultPrevented).toBe(false);
  expect(next).toHaveBeenCalledTimes(1);
  stop();
});
