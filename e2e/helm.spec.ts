import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { FreelensSession } from "./app";

const namespace = "power-helm-smoke";
const name = "sample-release";
const kubectl = (args: string[], input?: string) =>
  execFileSync(process.env.E2E_KUBECTL || "kubectl", args, { input, stdio: "pipe" }).toString();
function assertIsolatedCluster() {
  if (!process.env.KUBECONFIG || !process.env.FREELENS_EXECUTABLE || !process.env.EXTENSION_ARCHIVE)
    throw new Error("FREELENS_EXECUTABLE, KUBECONFIG and EXTENSION_ARCHIVE are required before fixtures");
  expect(kubectl(["config", "current-context"]).trim()).toBe("kind-power-e2e");
  const endpoint = new URL(kubectl(["config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"]));
  expect(endpoint.protocol).toBe("https:");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(endpoint.hostname);
}
function writeFixture(args: string[], input?: string) {
  assertIsolatedCluster();
  kubectl(args, input);
}

test.beforeAll(() => {
  const items: unknown[] = [{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } }];
  for (const revision of [1, 2]) {
    const status = revision === 1 ? "deployed" : "failed";
    const release = {
      name,
      namespace,
      version: revision,
      info: { status },
      chart: { metadata: { name: "sample-chart", version: "1.0.0", appVersion: "2.7-demo" } },
      config: { mode: revision === 1 ? "stable" : "proposed", replicas: revision },
      manifest: "",
    };
    items.push({
      apiVersion: "v1",
      kind: "Secret",
      type: "helm.sh/release.v1",
      metadata: {
        name: `sh.helm.release.v1.${name}.v${revision}`,
        namespace,
        labels: { owner: "helm", name, version: String(revision), status },
      },
      data: {
        release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString("base64"),
      },
    });
  }
  writeFixture(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items }));
});
test.afterAll(() =>
  writeFixture(["delete", "namespace", namespace, "--ignore-not-found", "--wait=true", "--timeout=60s"]),
);

test("Helm native fallback, history and safe read-only actions", async ({}, info) => {
  const session = new FreelensSession();
  let failed = true;
  try {
    await session.start(info);
    await session.install(info);
    const frame = await session.cluster(info);
    const sidebar = frame.getByTestId("cluster-sidebar");
    const native = sidebar.getByTestId("link-for-sidebar-item-helm");
    await expect(native).toBeVisible();
    await expect(sidebar.locator("[data-power-helm-sidebar-icon]")).toBeHidden();
    const settings = session.window.locator(".freelens-power-preferences");
    const helmToggle = settings.locator('label[data-testid="switch"]').filter({ hasText: "Enable Helm enhancements" });
    const openSettings = () => session.window.locator(".freelens-power-settings-icon").click();
    const closeSettings = () => session.window.getByTestId("close-preferences").click();
    await openSettings();
    await expect(helmToggle.locator('input[type="checkbox"]')).not.toBeChecked();
    await helmToggle.click();
    await closeSettings();
    await sidebar.getByText("Helm", { exact: true }).filter({ visible: true }).click();
    const page = frame.locator(".power-helm");
    await page.getByRole("textbox", { name: "Search releases", exact: true }).fill(name);
    const release = page.getByRole("button", { name, exact: true });
    await expect(release).toBeVisible();
    const row = release.locator("xpath=ancestor::tr");
    await expect(row).toContainText("Failed");
    await expect(row.locator(".helm-app-version-cell")).toContainText("2.7-demo");
    await release.click();
    const panel = page.getByRole("complementary");
    await panel.getByRole("tab", { name: "History", exact: true }).click();
    const historical = panel.getByRole("radio", { name: "Revision 1", exact: true }).locator("xpath=ancestor::tr");
    await expect(historical).toContainText("Deployed");
    await expect(historical.locator(".helm-app-version-cell")).toContainText("2.7-demo");
    await historical.getByRole("button", { name: "View revision", exact: true }).click();
    await expect(panel).toContainText("Historical revision");
    await expect(panel.locator(".view-lines")).toContainText("stable");
    await expect(panel.getByRole("button", { name: "Edit values", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Compare with current", exact: true }).click();
    const comparison = panel.getByRole("region", { name: "Revision comparison" });
    await expect(comparison).toBeVisible();
    await expect(comparison.getByRole("heading").filter({ hasText: "Revision 1" })).toBeVisible();
    await expect(comparison.getByRole("heading").filter({ hasText: "Latest · Revision 2" })).toBeVisible();
    await expect(comparison).toContainText("stable");
    await expect(comparison).toContainText("proposed");
    await expect(comparison.getByRole("checkbox", { name: "Show full documents", exact: true })).toHaveCount(0);
    const fullDocuments = comparison.getByRole("button", { name: "Compare full documents", exact: true });
    await fullDocuments.click();
    await expect(comparison.getByLabel("Full comparison documents", { exact: true })).toBeVisible();
    await comparison.getByRole("button", { name: "Next change", exact: true }).click();
    await expect(comparison).toContainText("stable");
    await expect(comparison).toContainText("proposed");
    await comparison.getByRole("button", { name: "Back to compact comparison", exact: true }).click();
    await expect(fullDocuments).toBeVisible();
    await expect(panel.locator(".helm-comparison-baseline .Select__single-value")).toContainText("Latest");
    await expect(comparison).toContainText("proposed");
    await panel.locator(".helm-comparison-baseline .Select__control").click();
    await frame.getByText("Last deployed · Revision 1", { exact: true }).last().click();
    await expect(panel).toContainText("No changes between these revisions");
    await fullDocuments.click();
    await expect(comparison).toContainText("No changes in full documents");
    await expect(comparison.getByLabel("Full comparison documents", { exact: true })).toBeVisible();
    await expect(comparison.locator(".helm-diff-pane")).toHaveCount(2);
    await comparison.getByRole("button", { name: "Back to compact comparison", exact: true }).click();
    await panel.getByRole("button", { name: "Back to current", exact: true }).click();
    await panel.getByRole("tab", { name: "History", exact: true }).click();
    await panel.getByRole("radio", { name: "Revision 1", exact: true }).check();
    await panel.getByRole("checkbox", { name: new RegExp(`I confirm rolling back ${name} to Revision 1`) }).check();
    await panel.getByRole("button", { name: "Roll back", exact: true }).click();
    const confirmation = frame.getByTestId("confirmation-dialog");
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toBeHidden();
    expect(
      JSON.parse(kubectl(["get", "secrets", "-n", namespace, "-l", `owner=helm,name=${name}`, "-o", "json"])).items,
    ).toHaveLength(2);
    await openSettings();
    await settings.locator('label[data-testid="switch"]').filter({ hasText: "Read-only mode" }).click();
    await closeSettings();
    await panel.getByRole("tab", { name: "Values", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Edit values", exact: true })).toHaveCount(0);
    await openSettings();
    await helmToggle.click();
    await closeSettings();
    await expect(sidebar.locator("[data-power-helm-sidebar-icon]")).toBeHidden();
    await expect(native).toBeVisible();
    failed = false;
  } finally {
    await session.close(info, true, failed);
  }
});
