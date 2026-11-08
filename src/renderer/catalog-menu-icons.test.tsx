// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => ({
  render: vi.fn((node, host) => {
    host.textContent = node.props.material || node.props.svg;
  }),
  unmount: vi.fn(),
}));
vi.mock("./react-roots", () => ({ renderIntoContainer: roots.render, unmountContainer: roots.unmount }));
vi.mock("@freelensapp/extensions", () => ({ Renderer: { Component: { Icon: () => null } } }));

import { startCatalogMenuIcons } from "./catalog-menu-icons";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("adds icons to catalog rows and native hotbar context menus without changing other menus", async () => {
  document.body.innerHTML =
    '<div data-testid="menu-actions-for-catalog-for-example"><div class="MenuItem">View Details</div><div class="MenuItem">Settings</div><div class="MenuItem">Connect</div><div class="MenuItem">Delete</div><div class="MenuItem">Add to Hotbar</div><div class="MenuItem"><i class="Icon"></i>Remove</div></div><div class="MenuItem">Settings</div><ul class="Menu portal"><li class="MenuItem">Remove from Hotbar</li><li class="MenuItem">Settings</li><li class="MenuItem">Connect</li><li class="MenuItem">Remove</li></ul>';
  const before = document.body.innerHTML;
  const stop = startCatalogMenuIcons();
  await Promise.resolve();
  expect(document.querySelectorAll("[data-power-catalog-menu-icon]")).toHaveLength(9);
  expect(roots.render).toHaveBeenCalledTimes(9);
  const item = document.querySelectorAll(".MenuItem")[4];
  item.lastChild!.textContent = "Remove from Hotbar";
  await Promise.resolve();
  expect(roots.render.mock.calls.at(-1)?.[0].props.svg).toBe("push_off");
  item.lastChild!.textContent = "Add to Hotbar";
  await Promise.resolve();
  stop();
  expect(document.body.innerHTML).toBe(before);
  expect(roots.unmount).toHaveBeenCalledTimes(9);
});
