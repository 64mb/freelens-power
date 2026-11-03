interface RemovalSummary {
  count: number;
  names: string[];
  remaining: number;
}

function summary(message: HTMLElement): RemovalSummary | undefined {
  const bold = [...message.children];
  if (bold.some((element) => element.tagName !== "B" || element.children.length)) return;
  const count = bold.length === 1 ? 1 : Number(bold[0]?.textContent);
  const names = (bold[count === 1 && bold.length === 1 ? 0 : 1]?.textContent ?? "").split(", ");
  const remaining = bold.length === 3 ? Number(bold[2].textContent) : 0;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    names.length + remaining !== count ||
    names.some((name) => !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(name))
  )
    return;
  const expected =
    count === 1
      ? `Remove item ${names[0]}?`
      : `Remove ${count} items ${names.join(", ")}${remaining ? `, and ${remaining} more` : ""}?`;
  if (message.textContent !== expected) return;
  return { count, names, remaining };
}

export function startPodRemovalConfirmation(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "pod-removal-confirmation";
  const scope = ".ConfirmDialog:has(.power-pod-removal-summary)";
  style.textContent = `
    ${scope} .power-pod-removal-original { display: none; }
    ${scope} > .box { max-width: min(720px,calc(100vw - 32px)); min-width: min(360px,calc(100vw - 32px)); }
    ${scope} .confirm-content { align-items: flex-start; gap: 12px; }
    ${scope} .confirm-content > .Icon { flex-shrink: 0; margin: 2px 0 0; }
    .power-pod-removal-summary { min-width: 0; overflow-wrap: anywhere; }
    .power-pod-removal-summary ul { list-style: disc; margin: 8px 0; padding-left: 24px; max-height: 40vh; overflow: auto; }
    .power-pod-removal-summary li { display: list-item; margin: 4px 0; }
    .power-pod-removal-remaining { color: var(--colorError); }
    :root ${scope} .Button.ok { display: inline-flex; align-items: center; gap: 6px; background: var(--colorError); color: #fff !important; }
    :root ${scope} .Button.ok:hover { background: color-mix(in srgb,var(--colorError) 88%,black); }
    .power-pod-removal-trash { --size: 18px; }
  `;
  document.head.append(style);
  let armed = false;
  let stopped = false;
  let expiration: number | undefined;
  let current:
    | { dialog: HTMLElement; message: HTMLElement; text: string | null; replacement: HTMLElement; icon: HTMLElement }
    | undefined;
  const restore = () => {
    if (!current) return;
    current.message.classList.remove("power-pod-removal-original");
    current.replacement.remove();
    current.icon.remove();
    current = undefined;
  };
  const reconcile = () => {
    if (stopped) return;
    const dialog = document.querySelector<HTMLElement>('.ConfirmDialog[data-testid="confirmation-dialog"]');
    if (current) {
      if (
        current.dialog === dialog &&
        current.message.isConnected &&
        current.replacement.isConnected &&
        current.text === current.message.textContent
      )
        return;
      restore();
    }
    if (!armed || !dialog) return;
    const message = dialog.querySelector<HTMLElement>(".confirm-content > p");
    const button = dialog.querySelector<HTMLButtonElement>('.confirm-buttons .Button.ok[data-testid="confirm"]');
    const parsed = message && summary(message);
    if (!message || !button || button.textContent !== "Remove" || !parsed) return;
    armed = false;
    const replacement = document.createElement("div");
    replacement.className = "power-pod-removal-summary";
    const heading = document.createElement("p");
    heading.textContent = `Remove ${parsed.count} ${parsed.count === 1 ? "pod" : "pods"}?`;
    const list = document.createElement("ul");
    for (const name of parsed.names) {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = name;
      item.append(code);
      list.append(item);
    }
    replacement.append(heading, list);
    if (parsed.remaining) {
      const tail = document.createElement("p");
      const number = document.createElement("b");
      number.className = "power-pod-removal-remaining";
      number.textContent = String(parsed.remaining);
      tail.append("and ", number, " more");
      replacement.append(tail);
    }
    const icon = document.createElement("span");
    icon.className = "Icon material power-pod-removal-trash";
    icon.setAttribute("aria-hidden", "true");
    const glyph = document.createElement("span");
    glyph.className = "icon";
    glyph.textContent = "delete";
    icon.append(glyph);
    message.classList.add("power-pod-removal-original");
    message.after(replacement);
    button.prepend(icon);
    current = { dialog, message, text: message.textContent, replacement, icon };
  };
  const arm = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(".Pods .AddRemoveButtons .remove-button");
    if (!button || button.disabled || button.classList.contains("disabled")) return;
    armed = true;
    window.clearTimeout(expiration);
    // keep capture armed through native click handlers and their microtask checkpoints
    expiration = window.setTimeout(() => {
      expiration = undefined;
      reconcile();
      armed = false;
    }, 0);
  };
  document.addEventListener("click", arm, true);
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-testid"],
  });
  return () => {
    stopped = true;
    armed = false;
    window.clearTimeout(expiration);
    document.removeEventListener("click", arm, true);
    observer.disconnect();
    restore();
    style.remove();
  };
}
