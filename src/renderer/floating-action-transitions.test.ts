// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFloatingActionTransitions } from "./floating-action-transitions";

const flush = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  vi.advanceTimersByTime(20);
};
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("floating action transitions", () => {
  it("keeps AI transitions while leaving native Create and Remove actions untouched when disabled", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<button class="power-ai-launcher">AI</button><div class="AddRemoveButtons"><button class="add-button">Create</button><button class="remove-button">Remove</button></div>';
    stop = startFloatingActionTransitions(false);
    expect(document.querySelector(".power-ai-launcher")?.hasAttribute("data-power-floating-enter")).toBe(true);
    expect(document.querySelector(".add-button")?.hasAttribute("data-power-floating-enter")).toBe(false);
    expect(document.querySelector(".remove-button")?.hasAttribute("data-power-floating-enter")).toBe(false);
    document.querySelector(".AddRemoveButtons")!.remove();
    await flush();
    expect(document.querySelector("[data-power-floating-ghost]")).toBeNull();
  });

  it("switches functional controls immediately and fades inert snapshots in both directions", async () => {
    vi.useFakeTimers();
    document.head.innerHTML =
      "<style>body:has(.AddRemoveButtons .remove-button) .power-ai-launcher{display:none}</style>";
    document.body.innerHTML =
      '<button class="power-ai-launcher" id="ai">AI</button><div class="AddRemoveButtons"></div>';
    stop = startFloatingActionTransitions();
    const ai = document.querySelector<HTMLElement>("#ai")!;
    expect(ai.hasAttribute("data-power-floating-enter")).toBe(true);
    const native = document.createElement("button");
    native.className = "remove-button";
    native.id = "remove";
    native.textContent = "Remove";
    const clicked = vi.fn();
    native.addEventListener("click", clicked);
    document.querySelector(".AddRemoveButtons")!.append(native);
    await flush();
    expect(getComputedStyle(ai).display).toBe("none");
    const ghost = document.querySelector<HTMLElement>("[data-power-floating-ghost]")!;
    expect(ghost.textContent).toBe("AI");
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(ghost.id).toBe("");
    expect(ghost.className).toBe("");
    native.click();
    expect(clicked).toHaveBeenCalledOnce();
    native.remove();
    await flush();
    expect(getComputedStyle(ai).display).not.toBe("none");
    expect(ai.hasAttribute("data-power-floating-enter")).toBe(true);
    const removeGhost = [...document.querySelectorAll<HTMLElement>("[data-power-floating-ghost]")].find(
      (el) => el.textContent === "Remove",
    )!;
    removeGhost.click();
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.querySelector("#remove")).toBeNull();
    vi.advanceTimersByTime(160);
    expect(document.querySelector("[data-power-floating-ghost]")).toBeNull();
  });

  it("cleans animation state and snapshots when disabled", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="AddRemoveButtons"><button class="remove-button">Remove</button></div>';
    stop = startFloatingActionTransitions();
    document.querySelector("button")!.remove();
    await flush();
    expect(document.querySelector("[data-power-floating-ghost]")).not.toBeNull();
    stop();
    expect(document.querySelector("[data-power-floating-ghost]")).toBeNull();
    expect(document.querySelector("[data-power-floating-enter]")).toBeNull();
    expect(document.querySelector("[data-freelens-power]")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unrelated tooltip and log updates without taking snapshots", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<button class="power-ai-launcher">AI</button><div class="Tooltip"></div><div class="logs"></div>';
    stop = startFloatingActionTransitions();
    const computed = vi.spyOn(window, "getComputedStyle");
    const clone = vi.spyOn(Node.prototype, "cloneNode");
    for (let index = 0; index < 30; index++) {
      (document.querySelector(".Tooltip") as HTMLElement).style.left = `${index}px`;
      document.querySelector(".logs")!.append(document.createElement("div"));
      await flush();
    }
    expect(computed).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    computed.mockRestore();
    clone.mockRestore();
  });

  it("coalesces relevant mutations and snapshots only changed controls", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button class="power-ai-launcher">AI</button><div class="AddRemoveButtons"></div>';
    stop = startFloatingActionTransitions();
    const ai = document.querySelector("button")!;
    const clone = vi.spyOn(ai, "cloneNode");
    for (let index = 0; index < 30; index++) {
      ai.style.right = `${index}px`;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    expect(clone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(clone).toHaveBeenCalledOnce();
    document.querySelector(".AddRemoveButtons")!.append(document.createElement("span"));
    await flush();
    expect(clone).toHaveBeenCalledOnce();
    clone.mockRestore();
  });

  it("lets the connected AI launcher fade itself when hidden by scrolling", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button class="power-ai-launcher">AI</button>';
    stop = startFloatingActionTransitions();
    const ai = document.querySelector("button")!;
    ai.classList.add("power-ai-launcher-hidden");
    await flush();
    expect(ai.isConnected).toBe(true);
    expect(document.querySelector("[data-power-floating-ghost]")).toBeNull();
    expect(ai.hasAttribute("data-power-floating-enter")).toBe(false);
    ai.classList.remove("power-ai-launcher-hidden");
    await flush();
    expect(ai.hasAttribute("data-power-floating-enter")).toBe(true);
    ai.remove();
    await flush();
    expect(document.querySelector("[data-power-floating-ghost]")).not.toBeNull();
  });

  it("skips animation for reduced motion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.body.innerHTML = '<button class="power-node-bulk-fab">Actions</button>';
    stop = startFloatingActionTransitions();
    expect(document.querySelector("[data-power-floating-enter]")).toBeNull();
    document.querySelector("button")!.remove();
    await flush();
    expect(document.querySelector("[data-power-floating-ghost]")).toBeNull();
  });
});
