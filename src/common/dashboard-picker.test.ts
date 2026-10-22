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
    const picked = dashboardPickerAdapter();
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
    const selection = dashboardPickerAdapter();
    document.querySelector("#chart\\:main")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await selection).toBe("#chart\\:main");
    const canceled = dashboardPickerAdapter();
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
    const pending = dashboardPickerAdapter();
    const overlay = document.documentElement.lastElementChild!;
    overlay.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true, clientX: 20, clientY: 20 }));
    const outline = overlay.shadowRoot!.firstElementChild as HTMLElement;
    expect(outline.style.display).toBe("block");
    expect(outline.style.borderColor).toBe("rgb(0, 229, 255)");
    expect(outline.style.borderRadius).toBe("6px");
    expect(outline.style.boxShadow).toBe("0 0 0 1px #111,inset 0 0 0 1px #111");
    expect(outline.style.pointerEvents).toBe("none");
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, clientX: 20, clientY: 20 }));
    expect(document.querySelector((await pending)!)).toBe(target);
    expect(clicked).not.toHaveBeenCalled();
    const canceled = dashboardPickerAdapter();
    document.documentElement
      .lastElementChild!.shadowRoot!.querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(await canceled).toBeNull();
    expect(document.documentElement.children).toHaveLength(2);
  });
  it("serializes the picker without appearance-dependent arguments", () => {
    expect(dashboardPickerScript()).toContain("border:2px solid #00e5ff");
    expect(dashboardPickerScript()).toMatch(/\)\(\)$/);
  });
});
