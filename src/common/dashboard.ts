import { normalizeDashboardSelector } from "./dashboard-selector";

export type DashboardCardSize = "s" | "m" | "l";

export interface DashboardCard {
  id: string;
  title: string;
  url: string;
  size: DashboardCardSize;
  autoRefresh?: boolean;
  selector?: string;
}

export function normalizeDashboardUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function sanitizeDashboardCards(value: unknown): DashboardCard[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const card = entry as Partial<DashboardCard>;
    const url = typeof card.url === "string" ? normalizeDashboardUrl(card.url) : undefined;
    if (!url) return [];
    const preferredId = typeof card.id === "string" ? card.id.trim() : "";
    let id = preferredId || `card-${encodeURIComponent(url)}`;
    for (let suffix = 2; ids.has(id); suffix++) id = `${preferredId || `card-${encodeURIComponent(url)}`}-${suffix}`;
    ids.add(id);
    return [
      {
        id,
        title: typeof card.title === "string" && card.title.trim() ? card.title.trim() : new URL(url).hostname,
        url,
        size: card.size === "s" || card.size === "l" ? card.size : "m",
        autoRefresh: card.autoRefresh === true,
        ...(normalizeDashboardSelector(card.selector) ? { selector: normalizeDashboardSelector(card.selector) } : {}),
      } satisfies DashboardCard,
    ];
  });
}
