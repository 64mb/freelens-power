// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { sanitizeDashboardCards } from "./dashboard";
import { dashboardSelectorAdapter, dashboardSelectorScript, normalizeDashboardSelector } from "./dashboard-selector";

const hidden = "data-power-selector-hidden";
afterEach(() => {
  dashboardSelectorAdapter("");
  document.body.innerHTML = "";
  vi.useRealTimers();
});
it("bounds selector input and serializes it only as a string argument", () => {
  expect(normalizeDashboardSelector(" main > .chart ")).toBe("main > .chart");
  for (const value of [42, "", "a".repeat(513), "main\nscript", "main\u0000"]) {
    expect(normalizeDashboardSelector(value)).toBeUndefined();
  }
  const selector = 'a[href="x\\\"),alert(1)//"]';
  expect(dashboardSelectorScript(selector)).toContain(`)(${JSON.stringify(selector)})`);
  expect(sanitizeDashboardCards([{ url: "https://example.com", selector: " main " }])[0].selector).toBe("main");
});
it("projects a subtree while preserving its ancestor chain and restores everything on reset", () => {
  document.body.innerHTML =
    '<header>Menu</header><main><aside>Other</aside><section id="chart"><b>Chart</b></section></main>';
  dashboardSelectorAdapter("#chart");
  expect(document.querySelector("header")?.hasAttribute(hidden)).toBe(true);
  expect(document.querySelector("aside")?.hasAttribute(hidden)).toBe(true);
  expect(document.querySelector("#chart")?.hasAttribute(hidden)).toBe(false);
  expect(document.querySelector("main")?.hasAttribute("data-power-selector-path")).toBe(true);
  dashboardSelectorAdapter("");
  expect(document.querySelector(`[${hidden}]`)).toBeNull();
  expect(document.querySelector("style")).toBeNull();
  expect(document.querySelector("#chart b")?.textContent).toBe("Chart");
});
it("falls back to the whole page for invalid or missing matches and follows dynamic replacements", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = "<main>Login</main>";
  dashboardSelectorAdapter("[");
  expect(document.documentElement.textContent).toContain("Selected element unavailable");
  expect(document.querySelector(`[${hidden}]`)).toBeNull();
  dashboardSelectorAdapter("#chart");
  document.body.innerHTML = '<nav>Menu</nav><main id="chart">Chart</main>';
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector("nav")?.hasAttribute(hidden)).toBe(true);
  expect(document.documentElement.textContent).not.toContain("Selected element unavailable");
});

it("adds one reversible inset around a matched element without changing website inline styles", () => {
  document.body.innerHTML = '<main><section id="chart">Chart</section></main>';
  document.body.style.padding = "5px";
  dashboardSelectorAdapter("#chart");
  expect(document.body.hasAttribute("data-power-selector-inset")).toBe(true);
  expect(document.querySelector("style")?.textContent).toContain("padding: 12px !important");
  dashboardSelectorAdapter("#missing");
  expect(document.body.hasAttribute("data-power-selector-inset")).toBe(false);
  expect(document.body.style.padding).toBe("5px");
  dashboardSelectorAdapter("");
  expect(document.body.style.padding).toBe("5px");
  document.body.style.removeProperty("padding");
});

it("publishes projection readiness only for the current applied target and restores it after replacement", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<nav>Menu</nav><main id="chart">Chart</main>';
  dashboardSelectorAdapter("#chart");
  const state = globalThis as typeof globalThis & {
    powerSelectorState?: { selector: string; target: Element | null; isApplied: () => boolean };
  };
  const projection = state.powerSelectorState!;
  expect(projection.selector).toBe("#chart");
  expect(projection.isApplied()).toBe(true);
  const original = projection.target;
  document.querySelector("#chart")!.outerHTML = '<section id="chart">Replacement</section>';
  expect(projection.isApplied()).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(projection.target).not.toBe(original);
  expect(projection.isApplied()).toBe(true);
  dashboardSelectorAdapter("");
  expect(state.powerSelectorState?.selector).toBe("");
  expect(state.powerSelectorState?.isApplied()).toBe(true);
});

it("isolates newly added outside branches during mutation delivery before the next paint", async () => {
  document.body.innerHTML = '<main id="chart">Chart</main>';
  dashboardSelectorAdapter("#chart");
  const navigation = document.createElement("nav");
  navigation.textContent = "New menu";
  document.body.prepend(navigation);
  await Promise.resolve();
  expect(navigation.hasAttribute(hidden)).toBe(true);
});

it("does not rebuild an applied projection for unrelated clock updates", async () => {
  document.body.innerHTML = '<main id="chart">Chart</main><aside id="clock">0</aside>';
  dashboardSelectorAdapter("#chart");
  const style = document.querySelector("style")!;
  const remove = vi.spyOn(style, "remove");
  document.querySelector("#clock")!.textContent = "1";
  await Promise.resolve();
  expect(remove).not.toHaveBeenCalled();
  remove.mockRestore();
});

it("preserves the in-document loading overlay without changing positional div selectors", () => {
  document.body.innerHTML = '<main><div>First</div><div id="chart">Chart</div></main>';
  const overlay = document.createElement("freelens-power-loading");
  document.documentElement.append(overlay);
  dashboardSelectorAdapter("main > div:nth-child(2)");
  const state = globalThis as typeof globalThis & {
    powerSelectorState?: { target: Element | null; isApplied: () => boolean };
  };
  expect(state.powerSelectorState?.target?.id).toBe("chart");
  expect(state.powerSelectorState?.isApplied()).toBe(true);
  expect(overlay.hasAttribute(hidden)).toBe(false);
  dashboardSelectorAdapter("");
  overlay.remove();
});
