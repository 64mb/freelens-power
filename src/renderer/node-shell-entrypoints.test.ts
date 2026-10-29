// @vitest-environment jsdom
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({ shell: { replaceDefaultNodeShell: false }, power: { enabled: true } }));
vi.mock("../common/store/node-shell-preferences-store", () => ({
  NodeShellPreferencesStore: { getInstanceOrCreate: () => stores.shell },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => stores.power },
}));

import { startNodeShellEntrypoints } from "./node-shell-entrypoints";

let stop: (() => void) | undefined;
const native = (id: string) =>
  `<div id="${id}" class="MenuItem"><span class="Icon svg"></span><span class="title">Shell</span></div>`;
const replacement = `<div class="MenuItem power-secure-node-shell-menu"><span class="Icon svg"></span><span class="title">Secure Node Shell</span></div>`;
const display = (id: string) => getComputedStyle(document.getElementById(id)!).display;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  stores.shell = observable({ replaceDefaultNodeShell: false });
  stores.power = observable({ enabled: true });
  document.body.innerHTML = `<div id="node-menu">${native("node-shell")}${replacement}<div id="cordon" class="MenuItem"><span class="title">Cordon</span></div></div><div>${native("pod-shell")}</div>`;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
});

it("replaces only the native sibling action and restores it on preference or Power disable", () => {
  stop = startNodeShellEntrypoints();
  expect(display("node-shell")).not.toBe("none");
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = true;
  });
  expect(display("node-shell")).toBe("none");
  expect(display("pod-shell")).not.toBe("none");
  expect(display("cordon")).not.toBe("none");
  expect(getComputedStyle(document.querySelector(".power-secure-node-shell-menu")!).display).not.toBe("none");
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = false;
  });
  expect(display("node-shell")).not.toBe("none");
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = true;
    stores.power.enabled = false;
  });
  expect(display("node-shell")).not.toBe("none");
  runInAction(() => {
    stores.power.enabled = true;
  });
  expect(display("node-shell")).toBe("none");
  stop();
  stop = undefined;
  expect(display("node-shell")).not.toBe("none");
});

it("handles lazy menus and restores native actions when the replacement moves or disappears", async () => {
  document.body.innerHTML = `<div id="node-menu">${native("node-shell")}</div><div id="other-menu"></div>`;
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = true;
  });
  stop = startNodeShellEntrypoints();
  expect(display("node-shell")).not.toBe("none");
  document.getElementById("node-menu")!.insertAdjacentHTML("beforeend", replacement);
  await flush();
  expect(display("node-shell")).toBe("none");
  const secure = document.querySelector<HTMLElement>(".power-secure-node-shell-menu")!;
  document.getElementById("other-menu")!.append(secure);
  await flush();
  expect(display("node-shell")).not.toBe("none");
  document.getElementById("node-menu")!.append(secure);
  await flush();
  expect(display("node-shell")).toBe("none");
  secure.remove();
  await flush();
  expect(display("node-shell")).not.toBe("none");
});

it("does not hide other SVG actions and restores a reused menu item when its title changes", async () => {
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = true;
  });
  stop = startNodeShellEntrypoints();
  const title = document.querySelector("#node-shell > .title")!;
  title.textContent = "Another action";
  await flush();
  expect(display("node-shell")).not.toBe("none");
  title.textContent = "Shell";
  await flush();
  expect(display("node-shell")).toBe("none");
  document.querySelector("#node-shell > .Icon")!.classList.remove("svg");
  await flush();
  expect(display("node-shell")).not.toBe("none");
});

it("does not reapply queued work after disposal", async () => {
  runInAction(() => {
    stores.shell.replaceDefaultNodeShell = true;
  });
  stop = startNodeShellEntrypoints();
  document.getElementById("node-menu")!.insertAdjacentHTML("beforeend", native("late-shell"));
  stop();
  stop = undefined;
  await flush();
  expect(display("node-shell")).not.toBe("none");
  expect(display("late-shell")).not.toBe("none");
});
