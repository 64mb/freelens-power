const channel = "freelens-power:hotbar-shortcut";

export interface HotbarFrameShortcut {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

function rendererOrigin(value: string, cluster = false): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (cluster
        ? /^[a-z0-9-]+\.renderer\.freelens\.app$/.test(url.hostname)
        : /^(?:[a-z0-9-]+\.)?renderer\.freelens\.app$/.test(url.hostname))
    )
      return url.origin;
  } catch {
    // ignore origins outside the native renderer
  }
  return undefined;
}

function isShortcut(value: unknown): value is HotbarFrameShortcut & { channel: string } {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 4 &&
    data.channel === channel &&
    typeof data.code === "string" &&
    /^Digit[0-9]$/.test(data.code) &&
    typeof data.metaKey === "boolean" &&
    typeof data.ctrlKey === "boolean" &&
    !(data.metaKey && data.ctrlKey) &&
    !(data.code === "Digit0" && (data.metaKey || data.ctrlKey))
  );
}

export function startHotbarFrameShortcuts(
  onShortcut: (shortcut: HotbarFrameShortcut) => void,
  context: Window = window,
): () => void {
  if (context.parent !== context) return () => {};
  const listener = (event: MessageEvent) => {
    if (!isShortcut(event.data) || !rendererOrigin(event.origin, true)) return;
    const frame = Array.from(
      context.document.querySelectorAll<HTMLIFrameElement>('#lens-views > iframe[id^="cluster-frame-"]'),
    ).find((candidate) => candidate.contentWindow === event.source);
    if (!frame || context.document.activeElement !== frame || rendererOrigin(frame.src, true) !== event.origin) return;
    for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
      const style = context.getComputedStyle(node);
      if (node.hidden || node.classList.contains("hidden") || style.display === "none" || style.visibility === "hidden")
        return;
    }
    const { code, metaKey, ctrlKey } = event.data;
    onShortcut({ code, metaKey, ctrlKey });
  };
  context.addEventListener("message", listener);
  return () => context.removeEventListener("message", listener);
}

export function forwardHotbarShortcut(event: KeyboardEvent, context: Window = window): boolean {
  if (
    context.parent === context ||
    !rendererOrigin(context.location.origin, true) ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey
  )
    return false;
  const data = { channel, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
  if (!isShortcut(data)) return false;
  const parentOrigin = rendererOrigin(context.document.referrer || context.location.ancestorOrigins?.[0] || "");
  if (!parentOrigin) return false;
  context.parent.postMessage(data, parentOrigin);
  return true;
}
