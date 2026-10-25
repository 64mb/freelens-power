// SPDX-License-Identifier: Apache-2.0

export function focusPreferencesSection(id: string): boolean {
  const section = document.getElementById(`freelens-power-${id}-section`);
  if (!section) return false;
  requestAnimationFrame(() => {
    if (!section.isConnected) return;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: "start", behavior: "instant" });
  });
  return true;
}

let cancelPendingNavigation: (() => void) | undefined;

export function openPreferencesSection(id: string, navigate: () => void): void {
  cancelPendingNavigation?.();
  const observer = new MutationObserver(() => {
    if (focusPreferencesSection(id)) cleanup();
  });
  const timeout = window.setTimeout(cleanup, 10_000);
  function cleanup() {
    observer.disconnect();
    window.clearTimeout(timeout);
    if (cancelPendingNavigation === cleanup) cancelPendingNavigation = undefined;
  }
  cancelPendingNavigation = cleanup;
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    navigate();
    if (focusPreferencesSection(id)) cleanup();
  } catch (error) {
    cleanup();
    throw error;
  }
}
