import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { FreelensSession } from "./app";

async function appendComment(session: FreelensSession, dialog: Locator, comment: string) {
  const input = dialog.getByRole("textbox", { name: "Kubeconfig YAML", exact: true });
  await input.focus();
  await input.press("ControlOrMeta+End");
  await session.window.keyboard.insertText(`\n# ${comment}\n`);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
}

test("Clusters catalog menus and isolated kubeconfig editor lifecycle", async ({}, info) => {
  const session = new FreelensSession();
  let failed = true;
  try {
    await session.start(info);
    await session.install(info);
    const window = session.window;
    const fixture = join(session.profile, "Freelens", "home", ".kube", "config");
    expect(await realpath(fixture)).not.toBe(await realpath(process.env.KUBECONFIG!));

    await window.getByRole("treeitem", { name: "General", exact: true }).click();
    const general = window.getByTestId("catalog-list-for-General");
    await expect(general).toBeVisible();
    const clustersEntry = general.locator(".TableRow").filter({
      has: window.getByTestId("icon-for-menu-actions-for-catalog-for-freelens-power-clusters"),
    });
    await expect(clustersEntry).toHaveCount(1);
    await clustersEntry.getByText("Clusters", { exact: true }).click();
    const catalog = window.getByTestId("catalog-list-for-Clusters");
    await expect(catalog).toBeVisible();
    const row = catalog.locator(".TableRow").filter({ has: window.getByText("kind-power-e2e", { exact: true }) });
    await expect(row).toHaveCount(1);
    await row.locator('[data-testid^="icon-for-menu-actions-for-catalog-for-"]').click();
    const menu = window.locator('[data-testid^="menu-actions-for-catalog-for-"]:visible');
    for (const title of ["View Details", "Settings", "Open kubeconfig"]) {
      const item = menu.locator(".MenuItem").filter({ hasText: new RegExp(`^\\s*(?:[a-z_]+\\s*)?${title}\\s*$`) });
      await expect(item).toBeVisible();
      await expect(item.locator(".Icon")).toHaveCount(1);
    }
    await menu
      .locator(".MenuItem")
      .filter({ hasText: /Open kubeconfig\s*$/ })
      .click();
    const dialog = window.getByRole("dialog", { name: "Kubeconfig", exact: true });
    await expect(dialog).toBeVisible();
    const editor = dialog.locator(".monaco-editor");
    await expect(editor).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Kubeconfig YAML", exact: true })).toBeVisible();
    const viewport = window.viewportSize()!;
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0)
      .toBeGreaterThan(Math.min(1200, viewport.width - 100));
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    await expect.poll(async () => (await editor.boundingBox())?.width ?? 0).toBeGreaterThan(bounds.width - 100);

    const input = dialog.getByRole("textbox", { name: "Kubeconfig YAML", exact: true });
    await input.focus();
    await input.press("ControlOrMeta+f");
    await expect(editor.locator(".find-widget.visible")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(editor.locator(".find-widget.visible")).toHaveCount(0);
    await expect(dialog).toBeVisible();

    const savedComment = "power isolated editor saved comment";
    await appendComment(session, dialog, savedComment);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Saved");
    expect((await readFile(fixture, "utf8")).includes(`# ${savedComment}`)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    const draftComment = "power isolated editor unsaved draft";
    const externalComment = "power isolated editor external change";
    await appendComment(session, dialog, draftComment);
    const savedText = await readFile(fixture, "utf8");
    await writeFile(fixture, `${savedText}\n# ${externalComment}\n`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Unable to save. Check the YAML and reload if the file changed outside this editor.",
    );
    await input.focus();
    await input.press("ControlOrMeta+End");
    await expect(editor.locator(".view-lines")).toContainText(draftComment);
    const conflictedText = await readFile(fixture, "utf8");
    expect(conflictedText.includes(`# ${externalComment}`)).toBe(true);
    expect(conflictedText.includes(`# ${draftComment}`)).toBe(false);

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await window.getByTestId("power-kubeconfig-editor-modal").click({ position: { x: 5, y: 5 } });
    await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();

    await dialog.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await input.focus();
    await input.press("ControlOrMeta+End");
    await expect(editor.locator(".view-lines")).toContainText(externalComment);
    await expect(editor.locator(".view-lines")).not.toContainText(draftComment);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    failed = false;
  } finally {
    await session.close(info, true, failed);
  }
});
