// @vitest-environment jsdom
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  helm: { enabled: false },
  power: { enabled: true },
}));
vi.mock("../common/store/helm-preferences-store", () => ({
  HelmPreferencesStore: { getInstanceOrCreate: () => stores.helm },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => stores.power },
}));

import { startPowerHelmEntrypoints } from "./helm-entrypoints";

let stop: (() => void) | undefined;
beforeEach(() => {
  stores.helm = observable({ enabled: false });
  stores.power = observable({ enabled: true });
  vi.stubGlobal("process", { isMainFrame: false });
  document.body.innerHTML = `<nav data-testid="cluster-sidebar">
    <div role="button" aria-roledescription="sortable" id="native-helm">
      <div class="SidebarItem_host-module" data-testid="sidebar-item-helm">
        <a data-testid="link-for-sidebar-item-helm" href="/">Helm</a>
        <div class="children"><a href="/helm/releases">Releases</a></div>
      </div>
    </div>
    <div role="button" aria-roledescription="sortable" id="power-helm">
      <div class="SidebarItem_host-module" data-testid="sidebar-item-extension-helm">
        <a href="/extension/freelens-power/helm"><span data-power-helm-sidebar-icon></span>Helm</a>
      </div>
    </div>
    <div role="button" aria-roledescription="sortable" id="neighbor">Configuration</div>
  </nav>
  <a id="native-page" href="/helm/releases?power-native=1">Native Helm</a>`;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
function display(id: string) {
  return getComputedStyle(document.getElementById(id)!).display;
}
function enable(helm: boolean, power = true) {
  runInAction(() => {
    stores.helm.enabled = helm;
    stores.power.enabled = power;
  });
}
it("hides the complete native Helm group only while Power Helm is enabled", () => {
  stop = startPowerHelmEntrypoints();
  expect(display("native-helm")).not.toBe("none");
  enable(true);
  expect(display("native-helm")).toBe("none");
  expect(display("power-helm")).not.toBe("none");
  expect(display("neighbor")).not.toBe("none");
  expect(display("native-page")).not.toBe("none");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  const nativeClick = vi.fn((event: Event) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  });
  document.getElementById("native-page")!.addEventListener("click", nativeClick, { once: true });
  document.getElementById("native-page")!.dispatchEvent(click);
  expect(nativeClick).toHaveBeenCalledOnce();
  enable(false);
  expect(display("native-helm")).not.toBe("none");
  enable(true, false);
  expect(display("native-helm")).not.toBe("none");
  enable(true);
  expect(display("native-helm")).toBe("none");
});
it("handles sidebar replacement and restores native markup on detach", () => {
  enable(true);
  stop = startPowerHelmEntrypoints();
  const native = document.getElementById("native-helm")!;
  native.replaceWith(native.cloneNode(true));
  expect(display("native-helm")).toBe("none");
  stop();
  expect(display("native-helm")).not.toBe("none");
  expect(document.querySelector('[data-freelens-power="helm-entrypoints"]')).toBeNull();
  enable(false);
  enable(true);
  expect(display("native-helm")).not.toBe("none");
  stop = startPowerHelmEntrypoints();
  expect(display("native-helm")).toBe("none");
});
it("does not change the root window sidebar", () => {
  vi.stubGlobal("process", { isMainFrame: true });
  enable(true);
  stop = startPowerHelmEntrypoints();
  expect(display("native-helm")).not.toBe("none");
  expect(document.querySelector('[data-freelens-power="helm-entrypoints"]')).toBeNull();
});

it("places Power Helm in the native custom position and restores its original position", async () => {
  const sidebar = document.querySelector("nav")!;
  const native = document.getElementById("native-helm")!;
  const own = document.getElementById("power-helm")!;
  const neighbor = document.getElementById("neighbor")!;
  sidebar.prepend(own);
  sidebar.append(native);
  const original = [...sidebar.children];
  stop = startPowerHelmEntrypoints();
  enable(true);
  expect(native.nextElementSibling).toBe(own);
  expect(neighbor.nextElementSibling).toBe(native);
  expect(stores.helm.enabled).toBe(true);
  expect(stores.power.enabled).toBe(true);
  enable(false);
  expect([...sidebar.children]).toEqual(original);
  enable(true);
  const replacement = native.cloneNode(true) as HTMLElement;
  native.replaceWith(replacement);
  sidebar.prepend(replacement);
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.nextElementSibling).toBe(own);
  stop();
  expect([...sidebar.children].map((item) => item.id)).toEqual(["native-helm", "power-helm", "neighbor"]);
});

it("places an asynchronously mounted replacement menu without reviving detached nodes", async () => {
  const sidebar = document.querySelector("nav")!;
  const own = document.getElementById("power-helm")!;
  own.remove();
  enable(true);
  stop = startPowerHelmEntrypoints();
  sidebar.prepend(own);
  await Promise.resolve();
  await Promise.resolve();
  expect(document.getElementById("native-helm")!.nextElementSibling).toBe(own);
  own.remove();
  const replacement = own.cloneNode(true);
  sidebar.prepend(replacement);
  await Promise.resolve();
  await Promise.resolve();
  expect(document.getElementById("native-helm")!.nextElementSibling).toBe(replacement);
  stop();
  expect(sidebar.firstElementChild).toBe(replacement);
  expect(own.isConnected).toBe(false);
});
