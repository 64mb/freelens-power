import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, expect, type Frame, type Page, type TestInfo } from "@playwright/test";

export class FreelensSession {
  app!: ElectronApplication;
  window!: Page;
  profile = "";
  private tracing = false;
  private diagnostics = "";

  async start(info: TestInfo) {
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
      await mkdir(join(home, ".freelens", "extensions"), { recursive: true });
      await copyFile(kubeconfig, join(home, ".kube", "config"));
      const archive = resolve(process.env.EXTENSION_ARCHIVE!);
      const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
      if (entries.some((entry) => !entry.startsWith("package/") || entry.split("/").includes(".."))) {
        throw new Error("Expected a safe pnpm package archive");
      }
      const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
      if (manifest.name !== "@64mb/freelens-power")
        throw new Error("Expected the freshly packed Freelens Power extension");
      const discoveryDirectory = join(home, ".freelens", "extensions", "64mb--freelens-power");
      await mkdir(discoveryDirectory, { recursive: true });
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", discoveryDirectory]);
      await writeFile(join(appData, "package.json"), JSON.stringify({ name: "freelens-ui-profile", private: true }));
      execFileSync(
        "pnpm",
        [
          "--dir",
          appData,
          "add",
          "--prod",
          "--ignore-scripts",
          "--store-dir",
          join(tmpdir(), "freelens-power-ui-pnpm-store"),
          archive,
        ],
        {
          env: { PATH: process.env.PATH, HOME: home },
          stdio: "pipe",
          timeout: 120_000,
        },
      );
      const installedScope = join(appData, "node_modules", "@64mb");
      await writeFile(
        join(appData, "lens-extensions.json"),
        JSON.stringify({
          extensions: {
            [join(installedScope, "freelens-power", "package.json")]: { enabled: true, name: manifest.name },
          },
        }),
      );
      await writeFile(
        join(appData, "lens-user-store.json"),
        JSON.stringify({
          preferences: {
            colorTheme: info.project.name.startsWith("light") ? "light" : "dark",
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
    const welcome = this.window.locator("[data-testid=welcome-menu-container] li a").first();
    if (await welcome.isVisible()) await welcome.click();
    return this;
  }

  async install() {
    const userData = await this.app.evaluate(({ app }) => app.getPath("userData"));
    expect(await realpath(userData)).toBe(await realpath(join(this.profile, "Freelens")));
    await expect(this.window.locator(".freelens-power-settings-icon")).toBeVisible();
  }

  async cluster(): Promise<Frame> {
    const welcome = this.window.getByText("Browse Clusters in Catalog", { exact: true });
    const catalog = this.window.locator("div.TableCell").getByText("kind-power-e2e", { exact: true }).first();
    const existingFrame = this.window.locator('[id^="cluster-frame-"]').first();
    await expect
      .poll(async () => (await welcome.isVisible()) || (await catalog.isVisible()) || (await existingFrame.isVisible()))
      .toBe(true);
    if (await welcome.isVisible()) await welcome.click();
    if (!(await existingFrame.isVisible())) {
      await expect(this.window.locator('[data-testid^="icon-for-menu-actions-for-catalog-for-"]')).toHaveCount(1);
      await catalog.click();
    }
    const iframe = this.window.locator('[id^="cluster-frame-"]').first();
    await expect(iframe).toBeVisible();
    const frame = await (await iframe.elementHandle())?.contentFrame();
    if (!frame) throw new Error("The kind cluster frame did not attach");
    await frame.locator("[data-testid=cluster-sidebar]").waitFor();
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
        await this.app.close();
      }
    }
    if (final && this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}
