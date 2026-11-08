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
    const firstHotbarIcon = window.locator('.HotbarMenu [id^="hotbarIcon-"]').first();
    await expect(firstHotbarIcon.locator("..").locator("[data-power-hotbar-number]")).toHaveText("1");
    await expect(firstHotbarIcon.locator("..").locator("[data-power-hotbar-number]")).toBeVisible();
    const numberBounds = (await firstHotbarIcon.locator("..").locator("[data-power-hotbar-number]").boundingBox())!;
    const categoryBounds = (await firstHotbarIcon
      .locator("..")
      .locator(':scope > .Icon[class*="badge"]')
      .boundingBox())!;
    const avatarBounds = (await firstHotbarIcon.boundingBox())!;
    expect(
      Math.abs(numberBounds.x + numberBounds.width / 2 - categoryBounds.x - categoryBounds.width / 2),
    ).toBeLessThan(1);
    expect(numberBounds.y).toBeGreaterThanOrEqual(avatarBounds.y + 1);
    expect(numberBounds.width).toBe(14);
    expect(numberBounds.height).toBe(14);
    const centerOffset = await firstHotbarIcon
      .locator("..")
      .locator("[data-power-hotbar-number]")
      .evaluate((badge) => {
        const range = document.createRange();
        range.selectNodeContents(badge);
        const text = range.getBoundingClientRect();
        const box = badge.getBoundingClientRect();
        return {
          x: Math.abs(text.x + text.width / 2 - box.x - box.width / 2),
          y: Math.abs(text.y + text.height / 2 - box.y - box.height / 2),
        };
      });
    expect(centerOffset.x).toBeLessThan(1.5);
    expect(centerOffset.y).toBeLessThan(1.5);
    const secondHotbar = window.locator('.HotbarMenu [id^="hotbarIcon-"]').nth(1);
    const secondNumber = (await secondHotbar.locator("..").locator("[data-power-hotbar-number]").boundingBox())!;
    expect(secondNumber.y - categoryBounds.y - categoryBounds.height).toBeGreaterThanOrEqual(2);
    const fixture = join(session.profile, "Freelens", "home", ".kube", "config");
    expect(await realpath(fixture)).not.toBe(await realpath(process.env.KUBECONFIG!));

    await window.getByRole("treeitem", { name: /General$/ }).click();
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
    for (const title of ["View Details", "Settings", "Open kubeconfig", "Edit icon"]) {
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
    const hotbarSelector = window.locator('.HotbarMenu [data-testid^="hotbar-menu-badge-for-"]');
    await hotbarSelector.click();
    await window.getByText("Add hotbar ...", { exact: true }).click();
    const panelName = window.getByPlaceholder("Hotbar name", { exact: true });
    await panelName.fill("Second panel");
    await panelName.press("Enter");
    await expect(hotbarSelector).toHaveText("2");
    await window.getByRole("treeitem", { name: /General$/ }).click();
    await clustersEntry.getByTestId("icon-for-menu-actions-for-catalog-for-freelens-power-clusters").click();
    await window
      .locator('[data-testid="menu-actions-for-catalog-for-freelens-power-clusters"] .MenuItem')
      .filter({ hasText: /Add to Hotbar\s*$/ })
      .click();
    await expect(window.locator(".HotbarMenu [data-power-hotbar-number]")).toHaveText(["1"]);
    const cluster = await session.cluster(info);
    await cluster.evaluate(() => {
      const button = document.createElement("button");
      button.id = "hotbar-shortcut-focus-fixture";
      button.textContent = "Shortcut focus fixture";
      document.body.append(button);
    });
    const focusFixture = cluster.locator("#hotbar-shortcut-focus-fixture");
    await focusFixture.focus();
    await window.keyboard.press("ControlOrMeta+1");
    await expect(hotbarSelector).toHaveText("1");
    await focusFixture.focus();
    await window.keyboard.press("1");
    await expect(window.locator('[id^="cluster-frame-"]').first()).not.toBeVisible();
    await window.locator("#hotbarIcon-catalog-entity").click();
    await window.getByRole("treeitem", { name: "Clusters", exact: true }).click();
    await expect(catalog).toBeVisible();
    const search = catalog.locator(":scope > .header .SearchInput input");
    await expect(search).toBeVisible();
    await expect(search).not.toBeFocused();
    await window.keyboard.press("ControlOrMeta+2");
    await expect(hotbarSelector).toHaveText("2");
    await expect(window.locator(".HotbarMenu [data-power-hotbar-number]")).toHaveText(["1"]);
    await search.focus();
    await window.keyboard.press("1");
    await expect(search).toHaveValue("1");
    await search.fill("");
    await search.blur();
    await window.keyboard.press("1");
    await expect(catalog).toBeVisible();
    failed = false;
  } finally {
    await session.close(info, true, failed);
  }
});
