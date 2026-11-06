import browserScript from "../browser/dashboard-ai.ts?browser-script";
import { redactAiTerminalText } from "./ai-terminal-context";

import type { DashboardCard } from "./dashboard";

export interface DashboardAiWidget {
  id: string;
  title: string;
  url: string;
}

export interface DashboardAiAccess {
  widgets: DashboardAiWidget[];
  read: (id: string, signal?: AbortSignal) => Promise<unknown>;
}

export function dashboardAiUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/token|password|secret|credential|authorization|api.?key|signature|^auth$|^sig$/i.test(key))
      url.searchParams.set(key, "[REDACTED]");
  }
  if (/token|password|secret|credential|authorization|api.?key|signature|(?:^|[&#])auth=/i.test(url.hash))
    url.hash = "[REDACTED]";
  return redactAiTerminalText(url.href).slice(0, 4096);
}

export function dashboardAiWidgets(cards: DashboardCard[]): DashboardAiWidget[] {
  return cards.slice(0, 100).map(({ title, url }, index) => ({
    id: `widget-${index + 1}`,
    title: redactAiTerminalText(title).slice(0, 512),
    url: dashboardAiUrl(url),
  }));
}

export function dashboardDocumentReadScript(selector?: string): string {
  return `(() => { ${browserScript}; return readDashboardDocument(${JSON.stringify(selector ?? null)}); })()`;
}
