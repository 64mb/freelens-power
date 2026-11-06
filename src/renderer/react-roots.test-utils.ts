import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ReactNode } from "react";

const roots = new Map<Element, Root>();

export function renderIntoContainer(node: ReactNode, container: Element): void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  flushSync(() => root.render(node));
}

export function unmountContainer(container: Element): void {
  const root = roots.get(container);
  if (!root) return;
  flushSync(() => root.unmount());
  roots.delete(container);
}

export function clearRenderedContainers(): void {
  for (const container of roots.keys()) unmountContainer(container);
}
