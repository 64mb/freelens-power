import browserScript from "../browser/dashboard-picker.ts?browser-script";
export const DASHBOARD_PICK_ELEMENT = "freelens-power:dashboard:pick-element";
export type DashboardPickerResult = { status: "selected"; selector: string } | { status: "canceled" | "error" };

export function dashboardPickerScript(): string {
  return `(() => { ${browserScript}; return dashboardPickerAdapter(); })()`;
}
