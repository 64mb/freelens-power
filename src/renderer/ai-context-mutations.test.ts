// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { hasAiContextMutations } from "./ai-context-mutations";

afterEach(() => {
  document.body.innerHTML = "";
});

it("ignores native tooltip portal insertion, positioning, content and removal", () => {
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  try {
    const tooltip = document.createElement("div");
    tooltip.className = "Tooltip narrow left formatter";
    document.body.append(tooltip);
    expect(hasAiContextMutations(observer.takeRecords())).toBe(false);
    tooltip.style.left = "100px";
    tooltip.style.top = "200px";
    tooltip.textContent = "Delete snapshot";
    expect(hasAiContextMutations(observer.takeRecords())).toBe(false);
    tooltip.firstChild!.textContent = "Updated tooltip";
    expect(hasAiContextMutations(observer.takeRecords())).toBe(false);
    tooltip.remove();
    expect(hasAiContextMutations(observer.takeRecords())).toBe(false);
  } finally {
    observer.disconnect();
  }
});

it("preserves drawer, overlay and mixed portal changes", () => {
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  try {
    const tooltip = document.createElement("div");
    tooltip.className = "Tooltip";
    const drawer = document.createElement("aside");
    drawer.className = "Drawer KubeObjectDetails";
    document.body.append(tooltip, drawer);
    expect(hasAiContextMutations(observer.takeRecords())).toBe(true);
    tooltip.style.top = "20px";
    drawer.hidden = true;
    expect(hasAiContextMutations(observer.takeRecords())).toBe(true);
    const overlay = document.createElement("dialog");
    overlay.open = true;
    document.body.append(overlay);
    expect(hasAiContextMutations(observer.takeRecords())).toBe(true);
    document.body.replaceChildren();
    expect(hasAiContextMutations(observer.takeRecords())).toBe(true);
  } finally {
    observer.disconnect();
  }
});
