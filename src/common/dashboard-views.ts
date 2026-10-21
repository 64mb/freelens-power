export const DASHBOARD_VIEWS_SYNC = "freelens-power:dashboard-views:sync";
export const DASHBOARD_VIEWS_RELOAD = "freelens-power:dashboard-views:reload";
export const DASHBOARD_VIEWS_CLEAR = "freelens-power:dashboard-views:clear";
export const DASHBOARD_VIEWS_LOADING = "freelens-power:dashboard-views:loading";

export interface DashboardViewLoading {
  id: string;
  url: string;
  loading: boolean;
  failed: boolean;
}

export interface DashboardViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DashboardViewPlacement {
  id: string;
  bounds: DashboardViewBounds;
  clip: DashboardViewBounds;
}

export const DASHBOARD_SITE_ICONS = "freelens-power:dashboard-site-icons";

export interface DashboardSiteIcon {
  id: string;
  pageUrl: string;
  dataUrl: string;
}

export const DASHBOARD_VIEWS_PIN = "freelens-power:dashboard-views:pin";
export const DASHBOARD_VIEWS_PINNED = "freelens-power:dashboard-views:pinned";
