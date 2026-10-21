export const dashboardSelectorLimit = 512;

export function normalizeDashboardSelector(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const selector = value.trim();
  return selector && selector.length <= dashboardSelectorLimit && !/[\u0000-\u001f\u007f]/.test(selector)
    ? selector
    : undefined;
}

// this function runs only inside the isolated website world
export function dashboardSelectorAdapter(selector: string): void {
  const state = globalThis as typeof globalThis & { powerSelectorCleanup?: () => void };
  state.powerSelectorCleanup?.();
  if (!selector) return;
  const hidden = "data-power-selector-hidden";
  const path = "data-power-selector-path";
  const inset = "data-power-selector-inset";
  let insetRoot: HTMLElement | undefined;
  let marked: Element[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const style = document.createElement("style");
  style.textContent = `[${hidden}] { display: none !important; } [${path}] { display: block !important; position: static !important; width: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; transform: none !important; } body[${inset}] { padding: 12px !important; box-sizing: border-box !important; }`;
  const notice = document.createElement("div");
  notice.textContent =
    "Selected element unavailable. Showing the whole page. Clear CSS selector in card settings to reset.";
  notice.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px;background:#292929;color:white;font:12px sans-serif";
  const observer = new MutationObserver(() => {
    if (!timer) timer = setTimeout(update, 200);
  });
  function restore() {
    for (const element of marked) {
      element.removeAttribute(hidden);
      element.removeAttribute(path);
    }
    marked = [];
    insetRoot?.removeAttribute(inset);
    insetRoot = undefined;
    style.remove();
    notice.remove();
  }
  function update() {
    timer = undefined;
    observer.disconnect();
    restore();
    let target: Element | null = null;
    try {
      target = document.querySelector(selector);
    } catch {}
    const branches: Element[] = [];
    const ancestors: Element[] = [];
    if (target && target !== document.documentElement && target !== document.body) {
      let child: Element = target;
      while (child.parentElement && ancestors.length < 128 && branches.length < 2000) {
        const parent = child.parentElement;
        ancestors.push(parent);
        for (const sibling of parent.children) {
          if (sibling !== child) branches.push(sibling);
          if (branches.length >= 2000) break;
        }
        child = parent;
      }
      if (ancestors.length >= 128 || branches.length >= 2000) target = null;
    }
    if (target) {
      for (const element of branches) element.setAttribute(hidden, "");
      for (const element of ancestors) element.setAttribute(path, "");
      marked = [...branches, ...ancestors];
      if (document.body) {
        insetRoot = document.body;
        insetRoot.setAttribute(inset, "");
      }
      document.documentElement.append(style);
    } else {
      document.documentElement.append(notice);
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  }
  state.powerSelectorCleanup = () => {
    observer.disconnect();
    clearTimeout(timer);
    restore();
    delete state.powerSelectorCleanup;
  };
  update();
}

export function dashboardSelectorScript(selector?: string): string {
  return `(${dashboardSelectorAdapter.toString()})(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
