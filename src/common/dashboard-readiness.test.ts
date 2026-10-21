// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dashboardReadinessAdapter, dashboardReadinessScript } from "./dashboard-readiness";

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
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("waits for a late SPA target, visible image completion and a final stable paint period", async () => {
  document.body.innerHTML = "<main>Loading</main>";
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#chart").then(done);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  document.body.innerHTML = '<main id="chart"><img src="https://example.com/chart.png" /></main>';
  const image = document.querySelector("img")!;
  let complete = false;
  vi.spyOn(image, "complete", "get").mockImplementation(() => complete);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled();
  complete = true;
  document.querySelector("main")!.append("Chart ready");
  await vi.advanceTimersByTimeAsync(500);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds continuously changing pages and missing selectors instead of keeping skeletons forever", async () => {
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#missing").then(done);
  await vi.advanceTimersByTimeAsync(7999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for the selected image itself to load before revealing its card", async () => {
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("#chart").then(done);
  await vi.advanceTimersByTimeAsync(300);
  document.body.innerHTML = '<img id="chart" src="https://example.com/chart.png" />';
  const image = document.querySelector("img")!;
  let complete = false;
  vi.spyOn(image, "complete", "get").mockImplementation(() => complete);
  await vi.advanceTimersByTimeAsync(1500);
  expect(done).not.toHaveBeenCalled();
  complete = true;
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("serializes selector text only as a bounded string argument", () => {
  const selector = 'main[data-name="chart"]';
  expect(dashboardReadinessScript(selector)).toContain(`)(${JSON.stringify(selector)})`);
  expect(dashboardReadinessScript("a".repeat(513))).toContain(')("")');
});

it("rechecks image readiness after the final paint delay", async () => {
  document.body.innerHTML = '<main><img src="https://example.com/chart.png" /></main>';
  let complete = true;
  vi.spyOn(document.querySelector("img")!, "complete", "get").mockImplementation(() => complete);
  const done = vi.fn();
  const pending = dashboardReadinessAdapter("").then(done);
  await vi.advanceTimersByTimeAsync(500);
  complete = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(done).not.toHaveBeenCalled();
  complete = true;
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(done).toHaveBeenCalledOnce();
});
