import { createPortal } from "react-dom";

import type { ReactNode } from "react";

export function MockTooltip({ targetId, children }: { targetId: string; children?: ReactNode }) {
  return createPortal(
    <span
      data-target-id={targetId}
      data-tooltip-text={typeof children === "string" ? children : String(children ?? "")}
    />,
    document.body,
  );
}

export function tooltipText(target: Element | null | undefined): string {
  return target
    ? (document.querySelector(`[data-target-id="${target.id}"]`)?.getAttribute("data-tooltip-text") ??
        document.querySelector(`[data-target-id="${target?.id}"]`)?.textContent ??
        "")
    : "";
}

export function tooltipTarget(text: string, root: ParentNode = document): HTMLElement | null {
  const tooltip = Array.from(document.querySelectorAll<HTMLElement>("[data-target-id]")).find(
    (node) =>
      (node.getAttribute("data-tooltip-text") ?? node.textContent) === text &&
      root.contains(document.getElementById(node.dataset.targetId!)),
  );
  return tooltip ? document.getElementById(tooltip.dataset.targetId!) : null;
}
