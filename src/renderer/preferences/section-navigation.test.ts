// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { openPreferencesSection } from "./section-navigation";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("waits for preferences to mount, then focuses and scrolls the requested section", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const navigate = vi.fn();
  openPreferencesSection("dashboard", navigate);
  expect(navigate).toHaveBeenCalledOnce();
  document.body.innerHTML = '<section id="freelens-power-dashboard-section" tabindex="-1"></section>';
  const section = document.querySelector("section")!;
  const scroll = vi.fn();
  section.scrollIntoView = scroll;
  await Promise.resolve();
  expect(document.activeElement).toBe(section);
  expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  document.body.append(document.createElement("div"));
  await Promise.resolve();
  expect(scroll).toHaveBeenCalledOnce();
});
