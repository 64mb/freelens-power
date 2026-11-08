import { createServer, type ServerResponse } from "node:http";
import { expect, type TestInfo, test } from "@playwright/test";
import { FreelensSession } from "./app";

interface WidgetState {
  pinned: boolean;
  ready: string;
  masked: boolean;
  scrollbar: string;
  display: string;
  overflow: boolean;
}

const title = "Scrollbar fixture";
const sizes = ["XS · Extra small", "S · Small", "M · Medium", "L · Large", "XL · Extra large"];

async function checkDashboardScrollbars(info: TestInfo) {
  const pending = new Set<ServerResponse>();
  let holdResources = false;
  let documents = 0;
  const finishImage = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  };
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/pending/")) {
      if (!holdResources) {
        finishImage(response);
        return;
      }
      pending.add(response);
      response.on("close", () => pending.delete(response));
      return;
    }
    if (request.url !== "/widget") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(
      `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><div style="height:2400px;width:2400px">Scrollable dashboard content</div><img src="/pending/${++documents}" width="1" height="1"></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  const url = `http://127.0.0.1:${address.port}/widget`;
  const session = new FreelensSession();
  let failed = true;
  let failure: unknown;
  try {
    await session.start(info);
    session.app.process().stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (/FATAL|Check failed|crashed|uncaught/i.test(text)) console.error(text);
    });
    await session.install(info);
    const page = session.window;
    const preferences = page.locator(".freelens-power-preferences");
    const openPreferences = async () => {
      await page.locator(".freelens-power-settings-icon").click();
      await expect(preferences).toBeVisible();
      await preferences
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: /Dashboard/ })
        .click();
    };
    const closePreferences = () =>
      page.locator('div[class*="close-button-module__closeButton--"][aria-label="Close"]').click();
    await openPreferences();
    await preferences
      .locator("#freelens-power-dashboard-section")
      .getByRole("button", { name: /Add card$/ })
      .click();
    const editor = page.getByRole("dialog", { name: "Add a card" });
    await editor.getByPlaceholder("Website name", { exact: true }).fill(title);
    await editor.getByPlaceholder("https://example.com", { exact: true }).fill(url);
    await editor.getByRole("button", { name: "Add card", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await closePreferences();
    await page.evaluate(
      "globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/extension/freelens-power/dashboard')",
    );
    const dashboard = page.locator(".freelens-power-dashboard");
    await expect(dashboard.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const states = () =>
      session.app.evaluate(async ({ webContents, BrowserWindow }, target) => {
        const results = await Promise.all(
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL() === target)
            .map(async (contents): Promise<WidgetState | undefined> => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const state = (await Promise.race([
                  contents.mainFrame.executeJavaScript(
                    `(() => ({ ready:document.readyState, masked:!!document.querySelector('freelens-power-loading'), scrollbar:getComputedStyle(document.documentElement).scrollbarWidth, display:getComputedStyle(document.documentElement,'::-webkit-scrollbar').display, overflow:document.documentElement.scrollHeight>innerHeight }))()`,
                  ),
                  new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Frame changed during probe")), 2000);
                  }),
                ])) as Omit<WidgetState, "pinned">;
                return {
                  pinned: BrowserWindow.getAllWindows().some((window) => window.webContents === contents),
                  ...state,
                };
              } catch {
                return undefined;
              } finally {
                clearTimeout(timer);
              }
            }),
        );
        return results.filter((state): state is WidgetState => state !== undefined);
      }, url);
    const expectMode = async (pinned: boolean, visible: boolean) => {
      await expect
        .poll(async () => (await states()).filter((state) => state.pinned === pinned && !state.masked).length)
        .toBe(1);
      const state = (await states()).find((state) => state.pinned === pinned)!;
      expect(state.ready).toBe("interactive");
      expect(state.overflow).toBe(true);
      expect(state.scrollbar).toBe(visible ? "auto" : "none");
      expect(state.display === "none").toBe(!visible);
      expect(pending.size).toBeGreaterThan(0);
    };
    const changeSize = async (size: string) => {
      await openPreferences();
      await preferences.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit card" });
      const sizeSelect = edit.getByRole("combobox", { name: "Card size", exact: true });
      await sizeSelect.focus();
      await sizeSelect.press("ArrowDown");
      await page.getByRole("option", { name: size, exact: true }).click();
      await edit.getByRole("button", { name: "Save card", exact: true }).click();
      await expect(edit).toHaveCount(0);
      await closePreferences();
    };
    await expect
      .poll(async () => (await states()).find((state) => !state.pinned && !state.masked)?.ready)
      .toBe("complete");
    await expect.poll(async () => (await states()).find((state) => !state.pinned)?.scrollbar).toBe("none");
    holdResources = true;
    await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => pending.size, { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await states()).find((state) => !state.pinned)?.ready).toBe("interactive");
    await expectMode(false, false);
    await dashboard.getByRole("button", { name: `Expand ${title}`, exact: true }).click();
    await expect.poll(async () => (await states()).find((state) => !state.pinned)?.scrollbar).toBe("auto");
    await expectMode(false, true);
    await dashboard.getByRole("button", { name: `Restore ${title}`, exact: true }).click();
    await expect.poll(async () => (await states()).find((state) => !state.pinned)?.scrollbar).toBe("none");
    const beforePin = pending.size;
    await dashboard.getByRole("button", { name: `Pin ${title}`, exact: true }).click();
    await expect.poll(() => pending.size, { timeout: 15000 }).toBeGreaterThan(beforePin);
    await expectMode(true, false);
    for (const size of sizes) {
      await changeSize(size);
      const visible = size.startsWith("L ·") || size.startsWith("XL ·");
      await expect
        .poll(async () => (await states()).find((state) => state.pinned)?.scrollbar)
        .toBe(visible ? "auto" : "none");
      await expectMode(true, visible);
    }
    await dashboard.getByRole("button", { name: `Unpin ${title}`, exact: true }).click();
    await expect.poll(async () => (await states()).filter((state) => state.pinned).length).toBe(0);
    await expectMode(false, false);
    holdResources = false;
    for (const response of pending) finishImage(response);
    await page.evaluate(
      "globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/catalog/entity.k8slens.dev/WebLink')",
    );
    const links = page.getByTestId("catalog-list-for-Web Links");
    await expect(links).toBeVisible();
    const link = links.getByText(title, { exact: true });
    await link.click();
    await expect.poll(async () => (await states()).filter((state) => state.pinned).length).toBe(1);
    await link.click();
    await expect.poll(async () => (await states()).filter((state) => state.pinned).length).toBe(1);
    const refreshControl = (click = false) =>
      session.app.evaluate(
        async ({ BrowserWindow }, args) => {
          const floating = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === args.url);
          if (!floating) return null;
          const controls = floating.contentView.children.filter(
            (view) =>
              "webContents" in view &&
              (view as Electron.WebContentsView).webContents.getURL().includes("dashboard-toggle-refresh"),
          );
          const control = controls[0] as Electron.WebContentsView | undefined;
          if (!control) return null;
          const pressed = await control.webContents.executeJavaScript(
            'document.querySelector("button")?.getAttribute("aria-pressed")',
          );
          if (args.click)
            await control.webContents.executeJavaScript('document.querySelector("button")?.click()', true);
          return { pressed, bounds: control.getBounds(), window: floating.getContentBounds(), count: controls.length };
        },
        { url, click },
      );
    await expect.poll(async () => (await refreshControl())?.pressed).toBe("false");
    const control = (await refreshControl())!;
    expect(control.count).toBe(1);
    expect(control.bounds).toEqual({
      x: control.window.width - 36,
      y: control.window.height - 36,
      width: 24,
      height: 24,
    });
    await refreshControl(true);
    await expect.poll(async () => (await refreshControl())?.pressed).toBe("true");
    await page.evaluate(
      "globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/extension/freelens-power/dashboard')",
    );
    const autoRefresh = dashboard.getByRole("button", { name: `Auto-refresh ${title} every 10 seconds`, exact: true });
    await expect(autoRefresh).toHaveAttribute("aria-pressed", "true");
    await autoRefresh.click();
    await expect.poll(async () => (await refreshControl())?.pressed).toBe("false");
    await dashboard.getByRole("button", { name: `Unpin ${title}`, exact: true }).click();
    await expect.poll(async () => (await states()).filter((state) => state.pinned).length).toBe(0);
    failed = false;
  } catch (error) {
    failure = error;
    console.error("Dashboard fixture failed before cleanup:", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    holdResources = false;
    for (const response of pending) finishImage(response);
    try {
      await session.close(info, true, failed);
    } catch (error) {
      if (!failure) throw error;
      console.error("Dashboard fixture cleanup failed:", error instanceof Error ? error.message : String(error));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
}

test("Dashboard scrollbar rules apply before slow resources finish loading", async ({}, info) => {
  await checkDashboardScrollbars(info);
});
