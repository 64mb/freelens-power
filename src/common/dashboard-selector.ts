import browserScript from "../browser/dashboard-selector.ts?browser-script";
export const dashboardSelectorLimit = 512;

export function normalizeDashboardSelector(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const selector = value.trim();
  return selector && selector.length <= dashboardSelectorLimit && !/[\u0000-\u001f\u007f]/.test(selector)
    ? selector
    : undefined;
}

export function dashboardSelectorScript(selector?: string): string {
  return `(() => { ${browserScript}; return dashboardSelectorAdapter; })()(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
