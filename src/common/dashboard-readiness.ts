import { normalizeDashboardSelector } from "./dashboard-selector";

// this function runs only inside the isolated website world
export function dashboardReadinessAdapter(selector: string): Promise<void> {
  return new Promise((resolve) => {
    let lastChange = Date.now();
    let lastLayout = "";
    let painting = false;
    let finished = false;
    const changed = () => {
      lastChange = Date.now();
    };
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
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
    const ready = () => {
      let target: Element | null = document.body;
      if (selector) {
        try {
          target = document.querySelector(selector);
        } catch {
          target = null;
        }
      }
      if (!target || document.readyState !== "complete" || document.fonts?.status === "loading") return false;
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      const layout = [bounds.x, bounds.y, bounds.width, bounds.height, target.scrollWidth, target.scrollHeight].join(
        ",",
      );
      if (layout !== lastLayout) {
        lastLayout = layout;
        changed();
      }
      const images = Array.from(target.querySelectorAll("img"));
      if (target instanceof HTMLImageElement) images.unshift(target);
      const pendingImages = images.some((image) => {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        return (
          !image.complete &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });
      return !pendingImages && Date.now() - lastChange >= 350;
    };
    const check = () => {
      if (finished || painting || !ready()) return;
      painting = true;
      void frame()
        .then(frame)
        .then(() => new Promise<void>((settled) => setTimeout(settled, 200)))
        .then(() => {
          painting = false;
          if (!finished && ready() && Date.now() - lastChange >= 550) finish();
        });
    };
    const interval = setInterval(check, 100);
    const deadline = setTimeout(finish, 8000);
    check();
  });
}

export function dashboardReadinessScript(selector?: string): string {
  return `(${dashboardReadinessAdapter.toString()})(${JSON.stringify(normalizeDashboardSelector(selector) ?? "")})`;
}
