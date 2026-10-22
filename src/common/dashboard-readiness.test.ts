// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dashboardReadinessAdapter, dashboardReadinessScript } from "./dashboard-readiness";
import { dashboardSelectorAdapter } from "./dashboard-selector";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 200,
    width: 300,
    height: 200,
    toJSON() {},
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  (globalThis as typeof globalThis & { powerSelectorCleanup?: () => void }).powerSelectorCleanup?.();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reveals basic page drawing without waiting for fonts, images or the load event", async () => {
  vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
  Object.defineProperty(document, "fonts", { configurable: true, value: { status: "loading" } });
  document.body.innerHTML = '<img src="https://example.com/pending.png" />';
  vi.spyOn(document.querySelector("img")!, "complete", "get").mockReturnValue(false);
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("").then(done);
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for a late selected target to actually be projected and painted", async () => {
  document.body.innerHTML = "<nav>Menu</nav>";
  dashboardSelectorAdapter("#chart");
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#chart").then(done);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  document.body.insertAdjacentHTML("beforeend", '<main id="chart">Chart</main>');
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  expect(document.querySelector("nav")?.hasAttribute("data-power-selector-hidden")).toBe(true);
  expect(done).toHaveBeenCalledOnce();
});

it("does not require stable live values after selector projection", async () => {
  document.body.innerHTML = '<main id="chart">Chart</main>';
  dashboardSelectorAdapter("#chart");
  const updates = setInterval(() => (document.querySelector("main")!.textContent = String(Date.now())), 20);
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#chart").then(done);
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  clearInterval(updates);
});

it("bounds a missing selector instead of keeping the skeleton forever", async () => {
  dashboardSelectorAdapter("#missing");
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#missing").then(done);
  await vi.advanceTimersByTimeAsync(7999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toHaveBeenCalledOnce();
});

it.each(["#second", ""])("follows selector changes to [%s] while waiting for a missing target", async (selector) => {
  document.body.innerHTML = '<main id="second">Second</main>';
  dashboardSelectorAdapter("#first");
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#first").then(done);
  await vi.advanceTimersByTimeAsync(300);
  dashboardSelectorAdapter(selector);
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  expect(done).toHaveBeenCalledOnce();
});

it("rechecks the applied target after paint when the SPA replaces it", async () => {
  document.body.innerHTML = '<main id="chart">Chart</main>';
  dashboardSelectorAdapter("#chart");
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#chart").then(done);
  await vi.advanceTimersByTimeAsync(150);
  document.querySelector("main")!.outerHTML = '<main id="chart">New chart</main>';
  await vi.advanceTimersByTimeAsync(60);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  expect(done).toHaveBeenCalledOnce();
});

it("serializes selector text only as a bounded string argument", () => {
  const selector = 'main[data-name="chart"]';
  expect(dashboardReadinessScript(selector)).toContain(`)(${JSON.stringify(selector)})`);
  expect(dashboardReadinessScript("a".repeat(513))).toContain(')("")');
});
