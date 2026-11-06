// this function runs inside the isolated website document and only reads rendered text
export function readDashboardDocument(selector?: string): { text: string; truncated: boolean } {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error("Configured widget selector is unavailable");
  const chunks: string[] = [];
  let length = 0;
  let visited = 0;
  let truncated = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (++visited > 20000 || length >= 24000) {
      truncated = true;
      break;
    }
    const node = walker.currentNode;
    const element = node.parentElement;
    if (
      !element ||
      element.closest(
        'script,style,noscript,input,textarea,select,option,[contenteditable],[role="textbox"],[hidden],[aria-hidden="true"],freelens-power-loading',
      )
    )
      continue;
    let visible = true;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        visible = false;
        break;
      }
    }
    if (!visible || !element.getClientRects().length) continue;
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const bounded = text.slice(0, 24000 - length);
    chunks.push(bounded);
    length += bounded.length + 1;
    if (bounded.length < text.length) truncated = true;
  }
  return { text: chunks.join("\n").slice(0, 24000), truncated };
}
