// SPDX-License-Identifier: Apache-2.0

// this preload runs before website scripts without requiring modules in the sandbox
(() => {
  const properties = [
    ["opacity", "0"],
    ["pointer-events", "none"],
  ] as const;
  const masked = new Map<HTMLElement, Map<string, { value: string; priority: string }>>();
  const overlay = document.createElement("freelens-power-loading");
  const style = (element: HTMLElement, values: Record<string, string>) => {
    for (const [property, value] of Object.entries(values)) element.style.setProperty(property, value, "important");
  };
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  style(overlay, {
    position: "fixed",
    inset: "0",
    display: "block",
    "z-index": "2147483647",
    "pointer-events": "all",
    opacity: "1",
    background: dark ? "#202124" : "#ffffff",
    padding: "20px",
    "box-sizing": "border-box",
    overflow: "hidden",
  });
  const shadow = overlay.attachShadow({ mode: "open" });
  for (let index = 0; index < 4; index++) {
    const bar = document.createElement("div");
    style(bar, {
      display: "block",
      background: dark ? "#393b40" : "#e8e9eb",
      "border-radius": "6px",
      width: index === 0 ? "45%" : "100%",
      height: index === 0 ? "20px" : index === 3 ? "calc(100vh - 148px)" : "12px",
      "min-height": index === 3 ? "30px" : "0",
      "margin-bottom": index === 0 ? "20px" : "12px",
    });
    shadow.append(bar);
  }
  const animations: Animation[] = [];
  let preparing = false;
  const restore = (element: HTMLElement) => {
    for (const [property, value] of properties) {
      const saved = masked.get(element)?.get(property);
      if (
        saved &&
        element.style.getPropertyValue(property) === value &&
        element.style.getPropertyPriority(property) === "important"
      ) {
        if (saved.value) element.style.setProperty(property, saved.value, saved.priority);
        else element.style.removeProperty(property);
      }
    }
    masked.delete(element);
  };
  const apply = () => {
    if (!preparing || !document.documentElement) return;
    if (overlay.parentElement !== document.documentElement) document.documentElement.append(overlay);
    for (const element of masked.keys()) {
      if (element.parentElement !== document.documentElement) restore(element);
    }
    for (const element of Array.from(document.documentElement.children)) {
      if (!(element instanceof HTMLElement) || element === overlay) continue;
      let previous = masked.get(element);
      if (!previous) {
        previous = new Map();
        masked.set(element, previous);
      }
      for (const [property, value] of properties) {
        const current = element.style.getPropertyValue(property);
        const priority = element.style.getPropertyPriority(property);
        if (!previous.has(property) || current !== value || priority !== "important") {
          previous.set(property, { value: current, priority });
          element.style.setProperty(property, value, "important");
        }
      }
    }
  };
  const observer = new MutationObserver(apply);
  const prepare = () => {
    if (!preparing && !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)) {
      for (const element of Array.from(shadow.children)) {
        if (element instanceof HTMLElement && typeof element.animate === "function") {
          try {
            animations.push(
              element.animate([{ opacity: 0.55 }, { opacity: 1 }], {
                duration: 1200,
                direction: "alternate",
                iterations: Infinity,
              }),
            );
          } catch {}
        }
      }
    }
    preparing = true;
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    apply();
  };
  const release = () => {
    preparing = false;
    for (const animation of animations) animation.cancel();
    animations.length = 0;
    observer.disconnect();
    for (const element of masked.keys()) restore(element);
    overlay.remove();
  };
  document.addEventListener("freelens-power:dashboard:preparing", prepare);
  document.addEventListener("freelens-power:dashboard:prepared", release);
  window.addEventListener("pagehide", () => {
    release();
    document.removeEventListener("freelens-power:dashboard:preparing", prepare);
    document.removeEventListener("freelens-power:dashboard:prepared", release);
  });
  prepare();
})();

export {};
