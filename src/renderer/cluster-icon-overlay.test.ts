// @vitest-environment jsdom
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";
import { defaultClusterIconDesign } from "../common/cluster-icons";

const state = vi.hoisted(() => ({
  icons: {},
  links: [] as { getId: () => string; spec: { url: string; icon?: { src: string } } }[],
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Catalog: { catalogEntities: { getItemsForApiKind: () => state.links } } },
}));
vi.mock("../common/store/cluster-icons-store", () => ({
  ClusterIconsStore: { getInstanceOrCreate: () => state.icons },
}));

import { startClusterIconOverlay } from "./cluster-icon-overlay";

afterEach(() => {
  document.body.innerHTML = "";
  state.links = [];
  history.replaceState({}, "", "/");
});

it("overlays only saved cluster icons and restores original DOM without native preference writes", async () => {
  state.icons = observable({ icons: { sample: { design: defaultClusterIconDesign("Sample") } } });
  document.body.innerHTML =
    '<div id="hotbarIcon-sample" style="background:red">AB</div><div id="hotbarIcon-other">CD</div><div class="TableRow"><div class="Avatar_hash"><img src="original.png"></div><button data-testid="icon-for-menu-actions-for-catalog-for-sample"></button></div><div data-testid="sidebar-cluster-dropdown" id="cluster-sample"><div class="Avatar_hash">AB</div></div><div data-testid="catalog-entity-details-content-for-sample"><div data-testid="detail-panel-hot-bar-icon">AB</div></div>';
  const before = document.body.innerHTML;
  const stop = startClusterIconOverlay();
  expect(getComputedStyle(document.getElementById("hotbarIcon-sample")!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(document.querySelectorAll("[data-power-icon-image]")).toHaveLength(4);
  expect(document.getElementById("hotbarIcon-other")?.hasAttribute("data-power-cluster-icon")).toBe(false);
  runInAction(() => {
    (state.icons as { icons: object }).icons = {};
  });
  expect(document.querySelectorAll("[data-power-icon-image]")).toHaveLength(0);
  expect(document.body.innerHTML).toBe(before);
  stop();
  expect(getComputedStyle(document.getElementById("hotbarIcon-sample")!).backgroundColor).toBe("rgb(255, 0, 0)");
  expect(document.body.innerHTML).toBe(before);
});

it("removes an overlay when a host avatar is reused for another cluster", async () => {
  state.icons = observable({ icons: { sample: { design: defaultClusterIconDesign("Sample") } } });
  document.body.innerHTML = '<div id="hotbarIcon-sample">AB</div>';
  const stop = startClusterIconOverlay();
  const avatar = document.querySelector<HTMLElement>("[id]")!;
  expect(avatar.querySelector("[data-power-icon-image]")).not.toBeNull();
  avatar.id = "hotbarIcon-other";
  await Promise.resolve();
  expect(avatar.querySelector("[data-power-icon-image]")).toBeNull();
  expect(avatar.textContent).toBe("AB");
  stop();
});

it("updates catalog icons immediately after saving while the action menu stays closed", () => {
  state.icons = observable({ icons: {} });
  document.body.innerHTML =
    '<div class="TableRow"><div class="Avatar_hash">AB</div><i data-testid="icon-for-menu-actions-for-catalog-for-sample"></i></div>';
  const stop = startClusterIconOverlay();
  expect(document.querySelector("[data-power-icon-image]")).toBeNull();
  runInAction(() => {
    (state.icons as { icons: object }).icons = { sample: { design: defaultClusterIconDesign("Sample") } };
  });
  const image = document.querySelector<HTMLImageElement>("[data-power-icon-image]");
  expect(image?.src).toContain("data:image/svg+xml");
  const original = image?.src;
  runInAction(() => {
    (state.icons as { icons: object }).icons = {
      sample: { design: { ...defaultClusterIconDesign("Sample"), label: "NEW" } },
    };
  });
  expect(image?.src).not.toBe(original);
  stop();
});

it("shows web link favicons only after loading and restores native avatars on failure or disable", () => {
  state.icons = observable({ icons: {} });
  state.links = [
    { getId: () => "site", spec: { url: "https://example.com/status" } },
    { getId: () => "cached", spec: { url: "https://example.org/", icon: { src: "cached.png" } } },
  ];
  document.body.innerHTML =
    '<div class="TableRow"><div class="Avatar_hash">EX</div><i data-testid="icon-for-menu-actions-for-catalog-for-site"></i></div><div id="hotbarIcon-site">EX</div><div class="TableRow"><div class="Avatar_hash"><img src="cached.png"></div><i data-testid="icon-for-menu-actions-for-catalog-for-cached"></i></div>';
  const before = document.body.innerHTML;
  const stop = startClusterIconOverlay();
  const images = Array.from(document.querySelectorAll<HTMLImageElement>("[data-power-icon-image]"));
  expect(images).toHaveLength(2);
  expect(getComputedStyle(images[0]).width).toBe("16px");
  expect(getComputedStyle(images[1]).width).toBe("100%");
  expect(getComputedStyle(document.querySelector<HTMLImageElement>('img[src="cached.png"]')!).width).toBe("16px");
  expect(images[0].src).toBe("https://example.com/favicon.ico");
  expect(document.querySelector("[data-power-cluster-icon]")).toBeNull();
  images[0].dispatchEvent(new Event("load"));
  expect(images[0].hidden).toBe(false);
  expect(images[0].parentElement?.hasAttribute("data-power-cluster-icon")).toBe(true);
  images[0].dispatchEvent(new Event("error"));
  expect(images[0].hidden).toBe(true);
  expect(images[0].parentElement?.hasAttribute("data-power-cluster-icon")).toBe(false);
  stop();
  expect(document.body.innerHTML).toBe(before);
});

it("updates both cluster settings avatars from saved designs and restores native markup", () => {
  history.replaceState({}, "", "/entity/sample/settings");
  state.icons = observable({ icons: { sample: { design: defaultClusterIconDesign("Sample") } } });
  document.body.innerHTML =
    '<div data-testid="entity-settings"><nav><div class="Avatar_hash">AB</div></nav><main><div class="Avatar_hash">AB</div></main></div>';
  const before = document.body.innerHTML;
  const stop = startClusterIconOverlay();
  const images = Array.from(document.querySelectorAll<HTMLImageElement>("[data-power-icon-image]"));
  expect(images).toHaveLength(2);
  const previous = images[0].src;
  runInAction(() => {
    (state.icons as { icons: object }).icons = {
      sample: { design: { ...defaultClusterIconDesign("Sample"), outlineColor: "#123456" } },
    };
  });
  expect(images[0].src).not.toBe(previous);
  expect(images[1].src).toBe(images[0].src);
  stop();
  expect(document.body.innerHTML).toBe(before);
});

it("keeps hotbar number badges visible on custom cluster avatars", () => {
  state.icons = observable({ icons: { sample: { design: defaultClusterIconDesign("Sample") } } });
  document.body.innerHTML =
    '<div class="HotbarMenu"><div id="hotbarIcon-sample"><span data-native-label>EX</span><span data-power-hotbar-number>1</span></div></div>';
  const stop = startClusterIconOverlay();
  const avatar = document.getElementById("hotbarIcon-sample")!;
  expect(avatar.hasAttribute("data-power-cluster-icon")).toBe(true);
  expect(getComputedStyle(avatar.querySelector("[data-native-label]")!).visibility).toBe("hidden");
  expect(getComputedStyle(avatar.querySelector("[data-power-hotbar-number]")!).visibility).toBe("visible");
  stop();
  expect(getComputedStyle(avatar.querySelector("[data-native-label]")!).visibility).toBe("visible");
});
