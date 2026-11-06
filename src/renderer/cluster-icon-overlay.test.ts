// @vitest-environment jsdom
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";
import { defaultClusterIconDesign } from "../common/cluster-icons";

const state = vi.hoisted(() => ({ icons: {} }));
vi.mock("../common/store/cluster-icons-store", () => ({
  ClusterIconsStore: { getInstanceOrCreate: () => state.icons },
}));

import { startClusterIconOverlay } from "./cluster-icon-overlay";

afterEach(() => {
  document.body.innerHTML = "";
});

it("overlays only saved cluster icons and restores original DOM without native preference writes", async () => {
  state.icons = observable({ icons: { sample: { design: defaultClusterIconDesign("Sample") } } });
  document.body.innerHTML =
    '<div id="hotbarIcon-sample" style="background:red">AB</div><div id="hotbarIcon-other">CD</div><div class="TableRow"><div class="Avatar_hash"><img src="original.png"></div><button data-testid="menu-actions-for-catalog-for-sample"></button></div><div data-testid="sidebar-cluster-dropdown" id="cluster-sample"><div class="Avatar_hash">AB</div></div><div data-testid="catalog-entity-details-content-for-sample"><div data-testid="detail-panel-hot-bar-icon">AB</div></div>';
  const before = document.body.innerHTML;
  const stop = startClusterIconOverlay();
  expect(document.querySelectorAll("[data-power-icon-image]")).toHaveLength(4);
  expect(document.getElementById("hotbarIcon-other")?.hasAttribute("data-power-cluster-icon")).toBe(false);
  runInAction(() => {
    (state.icons as { icons: object }).icons = {};
  });
  expect(document.querySelectorAll("[data-power-icon-image]")).toHaveLength(0);
  expect(document.body.innerHTML).toBe(before);
  stop();
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
