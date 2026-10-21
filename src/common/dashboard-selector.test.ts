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
