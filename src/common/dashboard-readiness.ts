import browserScript from "../browser/dashboard-readiness.ts?browser-script";
import { normalizeDashboardSelector } from "./dashboard-selector";

export function dashboardReadinessScript(selector?: string): string {
  return `(() => { ${browserScript}; return dashboardReadinessAdapter; })()(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
