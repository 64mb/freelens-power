export function hasAiContextMutations(mutations: MutationRecord[]): boolean {
  const isTooltip = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(".Tooltip") != null;

  return mutations.some((mutation) => {
    if (isTooltip(mutation.target)) return false;
    if (mutation.type !== "childList") return true;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length === 0 || changed.some((node) => !isTooltip(node));
  });
}
