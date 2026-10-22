import { normalizeDashboardSelector } from "./dashboard-selector";

// this function runs inside the website document
export function dashboardReadinessAdapter(selector: string): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let painting = false;
    const target = () => {
      const projection = (
        globalThis as typeof globalThis & {
          powerSelectorState?: { selector: string; target: Element | null; isApplied: () => boolean };
        }
      ).powerSelectorState;
      if (projection) selector = projection.selector;
      let element: Element | null = document.body;
      if (selector) {
        if (projection?.selector !== selector || !projection.isApplied()) return null;
        element = projection.target;
      }
      if (!element || document.readyState === "loading") return null;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 ? element : null;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      clearTimeout(deadline);
      resolve();
    };
    const frame = () =>
      new Promise<void>((painted) => {
        let id = 0;
        const timer = setTimeout(() => {
          cancelAnimationFrame(id);
          painted();
        }, 100);
        id = requestAnimationFrame(() => {
          clearTimeout(timer);
          painted();
        });
      });
    const check = () => {
      const element = target();
      if (finished || painting || !element) return;
      painting = true;
      void frame()
        .then(frame)
        .then(() => {
          painting = false;
          if (!finished && target() === element) finish();
        });
    };
    const interval = setInterval(check, 50);
    const deadline = setTimeout(finish, 8000);
    check();
  });
}

export function dashboardReadinessScript(selector?: string): string {
  return `(${dashboardReadinessAdapter.toString()})(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
