export const DASHBOARD_PICK_ELEMENT = "freelens-power:dashboard:pick-element";
export type DashboardPickerResult = { status: "selected"; selector: string } | { status: "canceled" | "error" };

// this function runs only in an isolated website world with no extension bridge
export function dashboardPickerAdapter(accent: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:auto!important";
    const shadow = overlay.attachShadow({ mode: "open" });
    const outline = document.createElement("div");
    outline.style.cssText = `position:fixed;box-sizing:border-box;border:2px solid ${accent};pointer-events:none;display:none`;
    const toolbar = document.createElement("div");
    toolbar.style.cssText =
      "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:12px 16px;background:#202124;color:#fff;border-radius:8px;font:13px system-ui;pointer-events:auto;display:flex;gap:16px;align-items:center";
    const hint = document.createElement("span");
    hint.textContent = "Hover an element, then click to select · Esc to cancel";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      "font:inherit;color:inherit;background:transparent;border:1px solid #888;border-radius:4px;padding:4px 10px;cursor:pointer";
    toolbar.append(hint, cancel);
    shadow.append(outline, toolbar);
    document.documentElement.append(overlay);
    let hovered: Element | undefined;
    const escape = (value: string) => CSS.escape(value);
    function selectorFor(target: Element): string | undefined {
      const matches = (selector: string) => {
        try {
          return (
            selector.length <= 512 &&
            document.querySelectorAll(selector).length === 1 &&
            document.querySelector(selector) === target
          );
        } catch {
          return false;
        }
      };
      if (target.id) {
        const id = `#${escape(target.id)}`;
        if (matches(id)) return id;
      }
      const path: string[] = [];
      let element: Element | null = target;
      for (let depth = 0; element && depth < 64; depth++, element = element.parentElement) {
        const tag = escape(element.localName);
        const siblings = element.parentElement ? Array.from(element.parentElement.children) : [element];
        path.unshift(`${tag}:nth-child(${siblings.indexOf(element) + 1})`);
        const selector = path.join(" > ");
        if (selector.length > 512) return;
        if (matches(selector)) return selector;
      }
      return undefined;
    }
    function finish(value: string | null) {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerdown", block, true);
      window.removeEventListener("pointerup", block, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("auxclick", block, true);
      window.removeEventListener("dblclick", block, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pagehide", cancelSelection, true);
      window.removeEventListener("scroll", draw, true);
      window.removeEventListener("resize", draw, true);
      overlay.remove();
      resolve(value);
    }
    function block(event: Event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function hit(event: Event): Element | undefined {
      if (event.composedPath().includes(toolbar)) return;
      let target = event.composedPath().find((node) => node instanceof Element);
      if (event.composedPath().includes(overlay) && event instanceof MouseEvent) {
        overlay.style.setProperty("pointer-events", "none", "important");
        target = document.elementFromPoint(event.clientX, event.clientY) ?? undefined;
        overlay.style.setProperty("pointer-events", "auto", "important");
      }
      return target instanceof Element && target.getRootNode() === document ? target : undefined;
    }
    function draw() {
      if (!hovered?.isConnected) {
        outline.style.display = "none";
        return;
      }
      const rect = hovered.getBoundingClientRect();
      Object.assign(outline.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }
    function move(event: PointerEvent) {
      hovered = hit(event);
      draw();
    }
    function click(event: MouseEvent) {
      const isCancel = event.composedPath().includes(cancel);
      block(event);
      if (isCancel) {
        finish(null);
        return;
      }
      const target = hit(event);
      if (!target) return;
      const selector = selectorFor(target);
      if (selector) finish(selector);
      else hint.textContent = "This element cannot be selected. Choose a containing element or cancel.";
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        block(event);
        finish(null);
      } else block(event);
    }
    function cancelSelection() {
      finish(null);
    }
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerdown", block, true);
    window.addEventListener("pointerup", block, true);
    window.addEventListener("click", click, true);
    window.addEventListener("auxclick", block, true);
    window.addEventListener("dblclick", block, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pagehide", cancelSelection, true);
    window.addEventListener("scroll", draw, true);
    window.addEventListener("resize", draw, true);
  });
}

export function dashboardPickerScript(accent: string): string {
  return `(${dashboardPickerAdapter.toString()})(${JSON.stringify(/^#[0-9a-f]{6}$/i.test(accent) ? accent : "#00a7a0")})`;
}
