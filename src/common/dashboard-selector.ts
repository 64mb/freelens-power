export const dashboardSelectorLimit = 512;

export function normalizeDashboardSelector(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const selector = value.trim();
  return selector && selector.length <= dashboardSelectorLimit && !/[\u0000-\u001f\u007f]/.test(selector)
    ? selector
    : undefined;
}

// this function runs inside the website document
export function dashboardSelectorAdapter(selector: string): void {
  const state = globalThis as typeof globalThis & {
    powerSelectorCleanup?: () => void;
    powerSelectorState?: { selector: string; target: Element | null; isApplied: () => boolean };
  };
  state.powerSelectorCleanup?.();
  if (!selector) {
    state.powerSelectorState = { selector, target: null, isApplied: () => true };
    state.powerSelectorCleanup = () => {
      delete state.powerSelectorState;
      delete state.powerSelectorCleanup;
    };
    return;
  }
  const hidden = "data-power-selector-hidden";
  const path = "data-power-selector-path";
  const inset = "data-power-selector-inset";
  let insetRoot: HTMLElement | undefined;
  let marked: Element[] = [];
  const style = document.createElement("style");
  style.textContent = `[${hidden}] { display: none !important; } [${path}] { display: block !important; position: static !important; width: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; transform: none !important; } body[${inset}] { padding: 12px !important; box-sizing: border-box !important; }`;
  const notice = document.createElement("div");
  notice.textContent =
    "Selected element unavailable. Showing the whole page. Clear CSS selector in card settings to reset.";
  notice.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px;background:#292929;color:white;font:12px sans-serif";
  const observer = new MutationObserver(() => {
    if (!projection.isApplied()) update();
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
  const projection = {
    selector,
    target: null as Element | null,
    isApplied: () => {
      const target = projection.target;
      if (!target || !style.isConnected) return false;
      try {
        if (document.querySelector(selector) !== target) return false;
      } catch {
        return false;
      }
      if (target === document.documentElement || target === document.body)
        return document.body?.hasAttribute(inset) ?? false;
      let child = target;
      let depth = 0;
      while (child.parentElement) {
        const parent = child.parentElement;
        if (!parent.hasAttribute(path) || ++depth >= 128) return false;
        for (const sibling of parent.children) {
          if (
            sibling !== child &&
            sibling !== style &&
            sibling.localName !== "freelens-power-loading" &&
            !sibling.hasAttribute(hidden)
          )
            return false;
        }
        child = parent;
      }
      return document.body?.hasAttribute(inset) ?? false;
    },
  };
  state.powerSelectorState = projection;
  function update() {
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
          if (sibling !== child && sibling.localName !== "freelens-power-loading") branches.push(sibling);
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
    projection.target = target;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  }
  state.powerSelectorCleanup = () => {
    observer.disconnect();
    restore();
    delete state.powerSelectorCleanup;
    delete state.powerSelectorState;
  };
  update();
}

export function dashboardSelectorScript(selector?: string): string {
  return `(${dashboardSelectorAdapter.toString()})(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
