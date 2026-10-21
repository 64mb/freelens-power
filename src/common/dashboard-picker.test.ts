// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardPickerAdapter, dashboardPickerScript } from "./dashboard-picker";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
describe("isolated dashboard element picker", () => {
  it("captures a unique structural selector without text or form values and suppresses click actions", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-z0-9_-]/gi, (char) => `\\${char}`) });
    document.body.innerHTML =
      '<main><article>First</article><article><input value="private-value"><button>Private account</button></article></main>';
    const target = document.querySelector("button")!;
    const clicked = vi.fn();
    target.addEventListener("click", clicked);
    const picked = dashboardPickerAdapter("#00a7a0");
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    const selector = await picked;
    expect(selector).toBeTruthy();
    expect(document.querySelectorAll(selector!)).toHaveLength(1);
    expect(document.querySelector(selector!)).toBe(target);
    expect(selector).not.toMatch(/private|account|value/i);
    expect(selector!.length).toBeLessThanOrEqual(512);
    expect(clicked).not.toHaveBeenCalled();
    expect(document.documentElement.children).toHaveLength(2);
    target.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it("escapes IDs and removes all overlays and listeners after Escape", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-z0-9_-]/gi, (char) => `\\${char}`) });
    document.body.innerHTML = '<div id="chart:main"></div>';
    const selection = dashboardPickerAdapter("#0273ee");
    document.querySelector("#chart\\:main")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await selection).toBe("#chart\\:main");
    const canceled = dashboardPickerAdapter("#0273ee");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(await canceled).toBeNull();
    expect(document.documentElement.children).toHaveLength(2);
  });
  it("selects through its pointer shield and its Cancel button leaves no selection", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    document.body.innerHTML = "<main><button>Website action</button></main>";
    const target = document.querySelector("button")!;
    const clicked = vi.fn();
    target.addEventListener("click", clicked);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const pending = dashboardPickerAdapter("#00a7a0");
    const overlay = document.documentElement.lastElementChild!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: 20, clientY: 20 }));
    expect(document.querySelector((await pending)!)).toBe(target);
    expect(clicked).not.toHaveBeenCalled();
    const canceled = dashboardPickerAdapter("#00a7a0");
    document.documentElement
      .lastElementChild!.shadowRoot!.querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(await canceled).toBeNull();
    expect(document.documentElement.children).toHaveLength(2);
  });
  it("validates injected accent colors", () => {
    expect(dashboardPickerScript('red; background:url("https://invalid.example")')).toContain('("#00a7a0")');
  });
});
