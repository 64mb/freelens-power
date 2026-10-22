// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { dashboardSelectorAdapter } from "../common/dashboard-selector";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  dashboardSelectorAdapter("");
  document.documentElement.innerHTML = "<head></head><body></body>";
  vi.resetModules();
});

it("masks website paint without removing content from layout and restores website styling only after readiness", async () => {
  document.body.innerHTML = '<main id="chart">Chart</main>';
  document.body.style.opacity = "0.75";
  await import("./dashboard-preload");
  expect(document.body.style.opacity).toBe("0");
  expect(document.querySelector("freelens-power-loading")?.shadowRoot?.children).toHaveLength(4);
  expect(document.body.style.getPropertyPriority("opacity")).toBe("important");
  expect(document.body.style.pointerEvents).toBe("none");
  expect(document.body.style.display).toBe("");
  expect(document.body.style.visibility).toBe("");
  expect(document.querySelector("#chart")?.textContent).toBe("Chart");
  document.body.style.opacity = "0.6";
  await Promise.resolve();
  expect(document.body.style.opacity).toBe("0");
  document.dispatchEvent(new Event("freelens-power:dashboard:prepared"));
  expect(document.body.style.opacity).toBe("0.6");
  expect(document.body.style.pointerEvents).toBe("");
  await Promise.resolve();
  expect(document.body.style.opacity).toBe("0.6");
  document.body.style.removeProperty("opacity");
});

it("installs the mask as soon as the parser creates the document root and supports subsequent preparation", async () => {
  document.documentElement.remove();
  await import("./dashboard-preload");
  const root = document.createElement("html");
  root.innerHTML = "<head></head><body>Website</body>";
  document.append(root);
  await Promise.resolve();
  expect(document.body.style.opacity).toBe("0");
  document.dispatchEvent(new Event("freelens-power:dashboard:prepared"));
  expect(document.body.style.opacity).toBe("");
  document.dispatchEvent(new Event("freelens-power:dashboard:preparing"));
  expect(document.body.style.opacity).toBe("0");
});

it("keeps the mask intact while selector isolation is applied and restored", async () => {
  document.body.innerHTML = '<nav>Menu</nav><main id="chart">Chart</main>';
  await import("./dashboard-preload");
  dashboardSelectorAdapter("#chart");
  await Promise.resolve();
  expect(document.body.style.opacity).toBe("0");
  dashboardSelectorAdapter("");
  await Promise.resolve();
  expect(document.body.style.opacity).toBe("0");
  document.dispatchEvent(new Event("freelens-power:dashboard:prepared"));
  expect(document.body.style.opacity).toBe("");
});

it("moves the visible skeleton to a replaced document root and restores both old and new website styles", async () => {
  document.body.style.opacity = "0.4";
  const previousBody = document.body;
  await import("./dashboard-preload");
  const replacement = document.createElement("html");
  replacement.innerHTML = '<head></head><body style="opacity:0.7">Replacement</body>';
  document.documentElement.replaceWith(replacement);
  await Promise.resolve();
  expect(previousBody.style.opacity).toBe("0.4");
  expect(document.body.style.opacity).toBe("0");
  expect(document.querySelector("freelens-power-loading")?.parentElement).toBe(replacement);
  document.dispatchEvent(new Event("freelens-power:dashboard:prepared"));
  expect(document.body.style.opacity).toBe("0.7");
  expect(document.querySelector("freelens-power-loading")).toBeNull();
});

it("pulses supported skeleton bars and cancels animations when preparation ends", async () => {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  try {
    await import("./dashboard-preload");
    expect(animate).toHaveBeenCalledTimes(4);
    document.dispatchEvent(new Event("freelens-power:dashboard:prepared"));
    expect(cancel).toHaveBeenCalledTimes(4);
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});
