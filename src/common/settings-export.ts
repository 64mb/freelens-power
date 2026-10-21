import { sanitizeAiShortcuts } from "./ai-shortcuts";
import { sanitizeDashboardCards } from "./dashboard";
import { normalizeDashboardSelector } from "./dashboard-selector";

export const SETTINGS_EXPORT = "freelens-power:settings:export";
export type SettingsExportResult = "saved" | "canceled" | "error";
export const SETTINGS_IMPORT = "freelens-power:settings:import";
export type SettingsImportResult = "restored" | "canceled" | "error";
export const SETTINGS_BACKUP_MAX_BYTES = 1024 * 1024;

export function parseSettingsImport(value: unknown) {
  const fail = () => {
    throw new Error("Invalid settings backup");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const backup = value as {
    format?: unknown;
    version?: unknown;
    dashboard?: { cards?: unknown };
    ai?: { shortcuts?: unknown };
  };
  if (backup.format !== "freelens-power-settings" || backup.version !== 1) return fail();
  const cards = backup.dashboard?.cards;
  const shortcuts = backup.ai?.shortcuts;
  if (!Array.isArray(cards) || !Array.isArray(shortcuts)) return fail();
  const ids = new Set<string>();
  for (const card of cards) {
    if (
      !card ||
      typeof card !== "object" ||
      typeof card.id !== "string" ||
      !card.id.trim() ||
      ids.has(card.id) ||
      typeof card.title !== "string" ||
      !card.title.trim() ||
      typeof card.url !== "string" ||
      !["xs", "s", "m", "l", "xl"].includes(card.size) ||
      (card.autoRefresh !== undefined && typeof card.autoRefresh !== "boolean") ||
      (card.selector !== undefined &&
        (typeof card.selector !== "string" || (card.selector.trim() && !normalizeDashboardSelector(card.selector))))
    )
      return fail();
    ids.add(card.id);
  }
  if (
    sanitizeDashboardCards(cards).length !== cards.length ||
    sanitizeAiShortcuts(shortcuts).length !== shortcuts.length
  )
    return fail();
  return createSettingsExport(cards, shortcuts);
}

function credentialKey(value: string): boolean {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    /(?:token|password|passwd|secret|credential|authorization|signature|apikey|session)/.test(key) ||
    ["auth", "key", "sig", "code", "jwt", "assertion", "ticket", "samlresponse"].includes(key)
  );
}

function exportUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (credentialKey(key)) url.searchParams.delete(key);
  }
  // preserve SPA routes unless the fragment contains credential parameters
  const fragment = url.hash.slice(1);
  const parameters = new URLSearchParams(fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment);
  if ([...parameters.keys()].some(credentialKey)) url.hash = "";
  return url.href;
}

export function createSettingsExport(cards: unknown, shortcuts: unknown) {
  const backup = {
    format: "freelens-power-settings",
    version: 1,
    dashboard: {
      cards: sanitizeDashboardCards(cards).map((card, index, all) => {
        const url = exportUrl(card.url);
        let id = card.id;
        if (/^card-https?%3a%2f%2f/i.test(id)) {
          id = `export-card-${index + 1}`;
          while (all.some((entry) => entry.id === id)) id += "-";
        }
        return { ...card, url, id };
      }),
    },
    ai: { shortcuts: sanitizeAiShortcuts(shortcuts) },
  };
  if (new TextEncoder().encode(`${JSON.stringify(backup, null, 2)}\n`).byteLength > SETTINGS_BACKUP_MAX_BYTES)
    throw new Error("Settings backup is too large");
  return backup;
}
