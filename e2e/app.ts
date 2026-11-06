import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, expect, type Frame, type Page, type TestInfo } from "@playwright/test";
import { cleanupTestProxies } from "./proxy-cleanup";

export class FreelensSession {
  app!: ElectronApplication;
  window!: Page;
  profile = "";
  private tracing = false;
  private archiveVersion = "";
  private archiveDigest = "";
  private diagnostics = "";

  async start(info: TestInfo) {
    if (process.platform === "darwin" && process.env.E2E_ALLOW_VISIBLE_UI !== "1")
      throw new Error("Run UI tests in Linux with Xvfb. Visible macOS tests require E2E_ALLOW_VISIBLE_UI=1.");
    const executablePath = process.env.FREELENS_EXECUTABLE;
    const kubeconfig = process.env.KUBECONFIG;
    if (!executablePath || !kubeconfig || !process.env.EXTENSION_ARCHIVE) {
      throw new Error("FREELENS_EXECUTABLE, KUBECONFIG and EXTENSION_ARCHIVE are required; no UI test is skipped");
    }
    if (!this.profile) {
      this.profile = await mkdtemp(join(tmpdir(), "freelens-power-e2e-"));
      const appData = join(this.profile, "Freelens");
      const home = join(appData, "home");
      await mkdir(join(home, ".kube"), { recursive: true });
      await copyFile(kubeconfig, join(home, ".kube", "config"));
      const archive = resolve(process.env.EXTENSION_ARCHIVE!);
      const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
      if (entries.some((entry) => !entry.startsWith("package/") || entry.split("/").includes(".."))) {
        throw new Error("Expected a safe pnpm package archive");
      }
      const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
      if (manifest.name !== "@64mb/freelens-power")
        throw new Error("Expected the freshly packed Freelens Power extension");
      if (manifest.type !== "module" || manifest.engines?.freelens !== "^2.0.0")
        throw new Error("Expected the freshly packed Freelens 2 extension");
      this.archiveVersion = manifest.version;
      this.archiveDigest = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
      await writeFile(
        join(appData, "lens-user-store.json"),
        JSON.stringify({
          preferences: {
            colorTheme: info.project.name.startsWith("light") ? "Light" : "Dark",
            syncKubeconfigEntries: [{ filePath: join(home, ".kube", "config") }],
            shell: "/bin/sh",
            allowTelemetry: false,
            allowErrorReporting: false,
          },
        }),
      );
    }
    this.app = await _electron.launch({
      executablePath,
      args: ["--integration-testing", "--no-sandbox", "--disable-gpu"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined &&
              [
                "PATH",
                "DISPLAY",
                "XAUTHORITY",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_RUNTIME_DIR",
                "LANG",
                "LC_ALL",
                "TMPDIR",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "NO_PROXY",
              ].includes(entry[0]),
          ),
        ),
        FREELENS_INTEGRATION_TESTING_DIR: this.profile,
        KUBECONFIG: resolve(kubeconfig),
        HOME: join(this.profile, "Freelens", "home"),
        XDG_CONFIG_HOME: join(this.profile, "config"),
      },
      timeout: 100_000,
    });
    for (const stream of [this.app.process().stdout, this.app.process().stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        this.diagnostics = (this.diagnostics + chunk.toString()).slice(-24_000);
      });
    }
    await expect
      .poll(() => this.app.windows().some((page) => page.url().startsWith("https://renderer.freelens.app")))
      .toBe(true);
    this.window = this.app.windows().find((page) => page.url().startsWith("https://renderer.freelens.app"))!;
    await this.window.setViewportSize(
      info.project.name.endsWith("narrow") ? { width: 960, height: 800 } : { width: 1440, height: 1000 },
    );
    await this.app.context().tracing.start({ screenshots: true, snapshots: false, sources: false });
    this.tracing = true;
    await this.window.waitForFunction(
      "typeof globalThis.FreelensExtensionApi?.Renderer?.Navigation?.navigate === 'function'",
      undefined,
      { timeout: 120_000 },
    );
    const welcome = this.window.locator("[data-testid=welcome-menu-container] li a").first();
    if (await welcome.isVisible()) await welcome.click();
    return this;
  }

  async install(info: TestInfo) {
    const runtime = JSON.parse(await readFile(new URL("./runtime-lock.json", import.meta.url), "utf8"));
    expect(await this.app.evaluate(({ app }) => app.getVersion())).toBe(runtime.freelens.version);
    const userData = await this.app.evaluate(({ app }) => app.getPath("userData"));
    expect(await realpath(userData)).toBe(await realpath(join(this.profile, "Freelens")));
    await this.window.evaluate("globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/extensions')");
    const page = this.window.getByTestId("extensions-page");
    await expect(page).toBeVisible();
    await page
      .getByPlaceholder("Name, URL, or path to a package or directory")
      .fill(resolve(process.env.EXTENSION_ARCHIVE!));
    await page.getByRole("button", { name: "Install", exact: true }).click();
    const installed = page.getByTestId("extensions-table");
    await expect(installed.getByText("@64mb/freelens-power", { exact: true })).toBeVisible();
    await expect(installed.getByText(this.archiveVersion, { exact: true })).toBeVisible();
    await expect(installed.getByText("Enabled", { exact: true })).toBeVisible();
    const managedBuild = join(
      userData,
      "extensions",
      "64mb--freelens-power",
      `${this.archiveVersion}-${this.archiveDigest.slice(0, 8)}`,
    );
    const installedManifest = JSON.parse(await readFile(join(managedBuild, "package.json"), "utf8"));
    expect(installedManifest.name).toBe("@64mb/freelens-power");
    expect(installedManifest.version).toBe(this.archiveVersion);
    const installNotice = this.window.locator(".Notifications .notification.info").filter({
      hasText: `Nothing vouches for the integrity of @64mb/freelens-power@${this.archiveVersion}: no checksum was available for this download. Installing it anyway.`,
    });
    await expect(installNotice).toBeVisible();
    await installNotice.locator('[data-testid^="close-notification-for-"]').click();
    await expect(installNotice).toHaveCount(0);

    await expect(this.window.locator(".freelens-power-settings-icon")).toBeVisible();
    await expect
      .poll(() =>
        this.window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--mainBackground").trim().toLowerCase(),
        ),
      )
      .toBe(info.project.name.startsWith("light") ? "#f1f1f1" : "#1e2124");
    await this.window.evaluate("globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/catalog')");
  }

  async cluster(info: TestInfo): Promise<Frame> {
    const existingFrame = this.window.locator('[id^="cluster-frame-"]').first();
    if (!(await existingFrame.isVisible())) {
      await this.window.evaluate("globalThis.FreelensExtensionApi.Renderer.Navigation.navigate('/catalog')");
      await this.window.getByRole("treeitem", { name: "Clusters", exact: true }).click();
      const catalog = this.window.getByTestId("catalog-list-for-Clusters");
      await expect(catalog).toBeVisible();
      await expect(catalog.locator('[data-testid^="icon-for-menu-actions-for-catalog-for-"]')).toHaveCount(1);
      const row = catalog
        .locator(".TableRow")
        .filter({ has: this.window.getByText("kind-power-e2e", { exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-testid^="icon-for-menu-actions-for-catalog-for-"]')).toHaveCount(1);
      await row.getByText("kind-power-e2e", { exact: true }).click();
    }
    const iframe = this.window.locator('[id^="cluster-frame-"]').first();
    await expect(iframe).toBeVisible();
    const frame = await (await iframe.elementHandle())?.contentFrame();
    if (!frame) throw new Error("The kind cluster frame did not attach");
    await frame.locator("[data-testid=cluster-sidebar]").waitFor();
    await expect
      .poll(() =>
        frame.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--mainBackground").trim().toLowerCase(),
        ),
      )
      .toBe(info.project.name.startsWith("light") ? "#f1f1f1" : "#1e2124");
    try {
      await frame.getByText("Diagnostics", { exact: true }).first().waitFor();
    } catch (error) {
      console.error(
        this.diagnostics
          .split("\n")
          .filter((line) => /error|ERR|failed/i.test(line))
          .slice(-12)
          .join("\n"),
      );
      throw error;
    }
    return frame;
  }

  async screenshot(info: TestInfo, name: string, target: Page | Frame = this.window) {
    const file = info.outputPath(`${name}.png`);
    await target.locator("body").screenshot({ path: file, animations: "disabled" });
    await info.attach(name, { path: file, contentType: "image/png" });
  }

  async close(info: TestInfo, final = true, failed = false) {
    if (this.app) {
      try {
        if ((failed || info.status !== info.expectedStatus) && this.window && !this.window.isClosed())
          await this.screenshot(info, "failure");
        if (this.tracing) {
          await this.app
            .context()
            .tracing.stop(failed || info.status !== info.expectedStatus ? { path: info.outputPath("trace.zip") } : {});
          if (failed || info.status !== info.expectedStatus) {
            await info.attach("trace", { path: info.outputPath("trace.zip"), contentType: "application/zip" });
          }
          this.tracing = false;
        }
      } finally {
        const child = this.app.process();
        const reap = () => cleanupTestProxies(this.profile);
        if (process.platform === "linux") child.once("exit", reap);
        try {
          if (process.platform === "linux" && (child.exitCode !== null || child.signalCode !== null)) reap();
          await this.app.close();
        } finally {
          child.removeListener("exit", reap);
        }
      }
    }
    if (final && this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}
