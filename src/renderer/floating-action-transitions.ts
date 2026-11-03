const duration = 160;

interface Snapshot {
  clone: HTMLElement;
  rect: DOMRect;
}

function snapshot(element: HTMLElement): Snapshot {
  const clone = element.cloneNode(true) as HTMLElement;
  const originals = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (const [index, original] of originals.entries()) {
    const copy = copies[index];
    const computed = getComputedStyle(original);
    for (const property of computed) copy.style.setProperty(property, computed.getPropertyValue(property));
    for (const attribute of [...copy.attributes]) {
      if (
        attribute.name === "id" ||
        attribute.name === "class" ||
        attribute.name.startsWith("data-") ||
        attribute.name.startsWith("on")
      )
        copy.removeAttribute(attribute.name);
    }
    copy.removeAttribute("data-power-floating-enter");
    copy.setAttribute("tabindex", "-1");
  }
  return { clone, rect: element.getBoundingClientRect() };
}

export function startFloatingActionTransitions(customizeResources = true): () => void {
  const selector = customizeResources
    ? ".AddRemoveButtons :is(.remove-button, .add-button):not([data-freelens-power-read-only]), .power-node-bulk-fab, .power-ai-launcher"
    : ".power-ai-launcher";
  const style = document.createElement("style");
  style.dataset.freelensPower = "floating-action-transitions";
  style.textContent = `
    @keyframes power-floating-enter { from { opacity: 0; } to { opacity: 1; } }
    @keyframes power-floating-exit { from { opacity: 1; } to { opacity: 0; } }
    [data-power-floating-enter] { animation: power-floating-enter ${duration}ms ease-out; }
    [data-power-floating-ghost], [data-power-floating-ghost] * { pointer-events: none !important; }
    @media (prefers-reduced-motion: reduce) { [data-power-floating-enter], [data-power-floating-ghost] { animation: none !important; } }
  `;
  document.head.append(style);
  const visible = new Map<HTMLElement, Snapshot>();
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const ghosts = new Set<HTMLElement>();
  const dirty = new Set<HTMLElement>();
  let frame: number | undefined;
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const watch = () =>
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-freelens-power-read-only"],
    });
  const update = () => {
    observer.disconnect();
    const current = new Set<HTMLElement>();
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest("[data-power-floating-ghost]")) continue;
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" ||
        computed.visibility === "hidden" ||
        element.hidden ||
        element.classList.contains("power-ai-launcher-hidden")
      )
        continue;
      current.add(element);
      if (!visible.has(element) && !reducedMotion()) {
        element.setAttribute("data-power-floating-enter", "");
        timers.set(
          element,
          setTimeout(() => {
            element.removeAttribute("data-power-floating-enter");
            timers.delete(element);
          }, duration),
        );
      }
      const previous = visible.get(element);
      const rect = element.getBoundingClientRect();
      if (!previous || dirty.has(element)) visible.set(element, snapshot(element));
      else previous.rect = rect;
    }
    for (const [element, previous] of visible) {
      if (current.has(element)) continue;
      visible.delete(element);
      element.removeAttribute("data-power-floating-enter");
      const pending = timers.get(element);
      if (pending) clearTimeout(pending);
      timers.delete(element);
      if (reducedMotion()) continue;
      if (
        element.isConnected &&
        element.classList.contains("power-ai-launcher-hidden") &&
        getComputedStyle(element).display !== "none"
      )
        continue;
      const { clone, rect } = previous;
      clone.dataset.powerFloatingGhost = "";
      clone.setAttribute("aria-hidden", "true");
      clone.setAttribute("inert", "");
      Object.assign(clone.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        right: "auto",
        bottom: "auto",
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: "0",
        transform: "none",
        animation: `power-floating-exit ${duration}ms ease-in forwards`,
        pointerEvents: "none",
        zIndex: "100",
      });
      ghosts.add(clone);
      document.body.append(clone);
      timers.set(
        clone,
        setTimeout(() => {
          clone.remove();
          ghosts.delete(clone);
          timers.delete(clone);
        }, duration),
      );
    }
    dirty.clear();
    watch();
  };
  const candidateSelector = ".remove-button, .add-button, .power-node-bulk-fab, .power-ai-launcher";
  const containsAction = (node: Node) =>
    node instanceof Element &&
    !node.closest("[data-power-floating-ghost]") &&
    (node.matches(candidateSelector) || !!node.querySelector(candidateSelector));
  const observer = new MutationObserver((records) => {
    let relevant = false;
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof Element) || target.closest("[data-power-floating-ghost]")) continue;
      const ownAction = target.closest<HTMLElement>(candidateSelector);
      const changedAction =
        record.type === "attributes"
          ? containsAction(target)
          : [...record.addedNodes, ...record.removedNodes].some(containsAction);
      const trackedAction = [...visible.keys()].some((element) => element === target || element.contains(target));
      if (!ownAction && !changedAction && !trackedAction) continue;
      relevant = true;
      for (const element of visible.keys()) {
        if (target === element || target.contains(element) || element.contains(target)) dirty.add(element);
      }
    }
    if (relevant && frame === undefined) {
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    }
  });
  update();
  return () => {
    observer.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    for (const timer of timers.values()) clearTimeout(timer);
    for (const element of visible.keys()) element.removeAttribute("data-power-floating-enter");
    for (const ghost of ghosts) ghost.remove();
    style.remove();
  };
}
