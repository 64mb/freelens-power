import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Frame, type Locator, type TestInfo, test } from "@playwright/test";
import { FreelensSession } from "./app";
import { applyFixtures, mutateConfigMap, secretSentinel } from "./fixtures";

test.beforeAll(() => applyFixtures());

async function triggerSearch(frame: Frame) {
  await frame.locator("body").click({ position: { x: 300, y: 10 } });
  await frame.page().keyboard.press("Shift");
  await frame.page().keyboard.press("Shift");
}

async function openSearch(frame: Frame) {
  await triggerSearch(frame);
  const dialog = frame.getByRole("dialog", { name: "Search resources" });
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true }),
  ).toBeFocused();
  return dialog;
}

async function search(dialog: Locator, name: string, kind?: string) {
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .fill(name);
  const matches = dialog.locator(`.power-resource-search-open:has(strong:text-is(${JSON.stringify(name)}))`);
  const result = kind ? matches.filter({ hasText: `${kind} ·` }) : matches;
  await expect(result).toBeVisible({ timeout: 180_000 });
  return result;
}

async function stablePress(button: Locator, capture?: (state: string) => Promise<void>) {
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await capture?.("hover");
  const before = await button.boundingBox();
  if (!before) throw new Error("Missing button geometry");
  await button.page().mouse.down();
  try {
    const pressed = await button.boundingBox();
    expect(pressed).toEqual(before);
    await capture?.("pressed");
  } finally {
    await button.page().mouse.up();
  }
}

function extensionTest(title: string, run: (session: FreelensSession, frame: Frame, info: TestInfo) => Promise<void>) {
  test(title, async ({}, info) => {
    const session = new FreelensSession();
    let failed = false;
    try {
      await session.start(info);
      await session.install(info);
      const frame = await session.cluster(info);
      await run(session, frame, info);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await session.close(info, true, failed);
    }
  });
}

extensionTest("universal search and trusted resource drawers", async (session, frame, info) => {
  let dialog = await openSearch(frame);
  const secret = await search(dialog, "k8s-lockbox-secret");
  await expect(secret).toContainText("Secret");
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .fill("k8s-secret");
  await expect(dialog.locator(".power-resource-search-open").filter({ hasText: "k8s-lockbox-secret" })).toBeVisible();
  for (const [name, kind] of [
    ["inventory-0519", "ConfigMap"],
    ["sample-widget", "Widget"],
    ["sample-cluster-widget", "ClusterWidget"],
    ["widgets.power.test", "CustomResourceDefinition"],
    ["team+ops", "ClusterRole"],
    ["system:discovery", "ClusterRole"],
  ]) {
    await expect(await search(dialog, name, kind)).toContainText(kind);
  }
  const contrast = await dialog
    .locator(".power-resource-search-row.selected")
    .first()
    .evaluate((row) => {
      const context = document.createElement("canvas").getContext("2d")!;
      function luminance(color: string) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      const foreground = luminance(getComputedStyle(row.querySelector("strong")!).color);
      const background = luminance(getComputedStyle(row).backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  expect(contrast, "Selected resource name contrast").toBeGreaterThanOrEqual(4.5);
  await session.screenshot(info, "search", frame);
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .press("Escape");
  await expect(dialog).toBeHidden();
  dialog = await openSearch(frame);
  await dialog.getByLabel("Filter by exact resource kind", { exact: true }).fill("Service");
  await search(dialog, "sample-service", "Service");
  await expect(dialog.locator(".power-resource-search-open")).toHaveCount(1);
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .press("ArrowDown");
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .press("ArrowUp");
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .press("Enter");
  await expect(dialog).toBeHidden();
  const drawer = frame.locator(".Drawer").filter({ hasText: "sample-service" }).last();
  await expect(drawer).toBeVisible();
  await drawer.getByText("sample-service", { exact: true }).first().click();
  await expect(drawer).toBeVisible();
  await session.screenshot(info, "resource-drawer", frame);
  const resize = drawer.locator(".ResizingAnchor.horizontal");
  const accentColor = await resize.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(element).getPropertyValue("--primary");
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await resize.hover();
  await expect
    .poll(() => resize.evaluate((element) => getComputedStyle(element, "::after").backgroundColor))
    .toBe(accentColor);
  await session.screenshot(info, "resource-drawer-resize-hover", frame);
  const anchorBox = await resize.boundingBox();
  if (!anchorBox) throw new Error("Native drawer resize handle is missing geometry");
  await frame.page().mouse.move(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
  await frame.page().mouse.down();
  try {
    await frame.page().mouse.move(anchorBox.x - 40, anchorBox.y + anchorBox.height / 2, { steps: 5 });
    await expect(resize).toHaveClass(/resizing/);
    await session.screenshot(info, "resource-drawer-resize-drag", frame);
  } finally {
    await frame.page().mouse.up();
  }
  await frame.page().keyboard.press("Escape");
  dialog = await openSearch(frame);
  await search(dialog, "team+ops");
  await dialog
    .getByRole("textbox", { name: "Resource name, namespace, kind, label or indexed text", exact: true })
    .press("Enter");
  await expect(frame.locator(".Drawer").filter({ hasText: "team+ops" })).toBeVisible();
  await frame.page().keyboard.press("Escape");

  if (process.env.E2E_LANE === "extended") {
    mutateConfigMap("create");
    try {
      const churnDialog = await openSearch(frame);
      await churnDialog.getByRole("button", { name: "Refresh resource inventory", exact: true }).click();
      await search(churnDialog, "churn-marker");
      await churnDialog.getByRole("button", { name: "Close resource search" }).click();
    } finally {
      mutateConfigMap("delete");
    }
    const dbFiles: string[] = [];
    async function findDatabases(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await findDatabases(file);
        else if (file.includes("freelens-power-search") && /^resources\.sqlite(?:-(?:wal|journal))?$/.test(entry.name))
          dbFiles.push(file);
      }
    }
    await findDatabases(session.profile);
    expect(dbFiles.length, "The packaged search must persist its metadata index").toBeGreaterThan(0);
    for (const file of dbFiles) {
      const contents = await readFile(file);
      for (const value of [secretSentinel, Buffer.from(secretSentinel).toString("base64")]) {
        expect(contents.includes(Buffer.from(value))).toBe(false);
      }
    }
  }
});

extensionTest("Diagnostics pending, readiness and attention views", async (session, frame, info) => {
  await frame.getByText("Diagnostics", { exact: true }).first().click();
  await expect(frame.getByRole("heading", { name: "Resource diagnostics" })).toBeVisible();
  await frame.getByTitle("Show pending", { exact: true }).click();
  await frame.getByRole("combobox", { name: "Pending pod", exact: true }).click();
  await frame.getByText("power-test / pending-workload", { exact: true }).click();
  await expect(frame.locator(".pending-heading")).toContainText("pending-workload");
  await frame.getByTitle("Show not ready", { exact: true }).click();
  await expect(frame.getByTitle("Show not ready", { exact: true })).toHaveAttribute("aria-pressed", "true");
  await frame.getByRole("combobox", { name: "Not ready pod", exact: true }).click();
  await frame.getByText("power-test / unready-workload", { exact: true }).click();
  await expect(frame.locator(".pending-heading")).toContainText("unready-workload");
  await frame.getByTitle("Show consumers", { exact: true }).click();
  await frame.getByText("Needs attention", { exact: true }).first().click();
  await session.screenshot(info, "diagnostics", frame);
});

extensionTest("Gateway Relationships graph and saved toggle", async (session, frame, info) => {
  await frame.getByText("Relationships", { exact: true }).first().click();
  await expect(frame.getByRole("heading", { name: "Resource relationships" })).toBeVisible();
  await frame.getByRole("combobox", { name: "Relationship namespace", exact: true }).click();
  await frame.getByText("power-test", { exact: true }).last().click();
  await frame.getByRole("combobox", { name: "Relationship Service", exact: true }).click();
  await frame.getByText("sample-service", { exact: true }).last().click();
  await expect(frame.locator(".power-relationships .graph")).toBeVisible();
  await expect(frame.locator(".power-relationships .graph")).toContainText("sample-route");
  await expect(frame.locator(".power-relationships .graph")).toContainText("ready-workload");
  await expect(frame.locator(".power-relationships .graph")).toContainText("Deployment");
  await session.screenshot(info, "relationships-normal", frame);
  await frame.locator(".power-relationships .graph").getByRole("button", { name: "sample-route", exact: true }).hover();
  await session.screenshot(info, "relationships-hover", frame);
  await frame.locator(".power-relationships .graph").getByRole("button", { name: "sample-route", exact: true }).click();
  await expect(frame.locator(".Drawer").filter({ hasText: "sample-route" })).toBeVisible();
  await frame.page().keyboard.press("Escape");
  const toggle = frame.getByRole("button", { name: /Hide Upstream/ });
  await stablePress(toggle);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await session.screenshot(info, "relationships-pressed", frame);
  await frame.getByText("Diagnostics", { exact: true }).first().click();
  await frame.getByText("Relationships", { exact: true }).first().click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  if (process.env.E2E_LANE === "extended") {
    await session.close(info, false);
    await session.start(info);
    const restarted = await session.cluster(info);
    await restarted.getByText("Relationships", { exact: true }).first().click();
    await expect(restarted.getByRole("button", { name: /Hide Upstream/ })).toHaveAttribute("aria-pressed", "true");
  }
});

extensionTest("Settings jumps and stable pointer geometry", async (session, frame, info) => {
  await session.window.locator(".freelens-power-settings-icon").click();
  const settings = session.window.locator(".freelens-power-preferences");
  await expect(settings).toBeVisible();
  const sections = settings.getByRole("navigation", { name: "Settings sections" });
  const buttons = sections.getByRole("button");
  const boxes = [];
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error("Settings button is missing geometry");
    expect(box.width).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(session.window.viewportSize()!.width);
    const textFits = await button.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(textFits, `Settings section text fits: ${await button.innerText()}`).toBe(true);
    for (const other of boxes) {
      const overlapWidth = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
      const overlapHeight = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
      expect(overlapWidth > 1 && overlapHeight > 1, "Settings section buttons overlap").toBe(false);
    }
    boxes.push(box);
  }
  const color = await settings.evaluate((element) => getComputedStyle(element).color);
  const brightness = (color.match(/\d+/g) || []).slice(0, 3).reduce((sum, value) => sum + Number(value), 0);
  if (info.project.name.startsWith("light")) expect(brightness).toBeLessThan(400);
  else expect(brightness).toBeGreaterThan(400);
  await session.screenshot(info, "settings-normal");
  await stablePress(sections.getByRole("button", { name: /Monitoring/ }), (state) =>
    session.screenshot(info, `settings-${state}`),
  );
  await expect(settings.locator("#freelens-power-monitoring-section")).toBeFocused();
  await session.screenshot(info, "settings-focus");
  await settings.getByText("Enable Freelens Power", { exact: true }).click();
  await expect(frame.getByText("Diagnostics", { exact: true })).toHaveCount(0);
  await expect(frame.locator("[data-testid=cluster-sidebar]")).toHaveCount(1);
  await settings.getByText("Enable Freelens Power", { exact: true }).click();
  await expect(frame.getByText("Diagnostics", { exact: true })).toHaveCount(1);
  const searchSwitch = settings.locator('label[data-testid="switch"]').filter({ hasText: /Enable resource search/ });
  await searchSwitch.click();
  await expect(searchSwitch.locator("input")).not.toBeChecked();
  await session.screenshot(info, "settings-search-disabled");
  const closeSettings = () =>
    session.window.locator('div[class*="close-button-module__closeButton--"][aria-label="Close"]').click();
  await closeSettings();
  await triggerSearch(frame);
  await expect(frame.getByRole("dialog", { name: "Search resources" })).toHaveCount(0);
  await expect(frame.getByText("Diagnostics", { exact: true }).first()).toBeVisible();
  await expect(frame.getByText("Relationships", { exact: true }).first()).toBeVisible();
  let activeFrame = frame;
  if (process.env.E2E_LANE === "extended") {
    await session.close(info, false);
    await session.start(info);
    activeFrame = await session.cluster(info);
    await triggerSearch(activeFrame);
    await expect(activeFrame.getByRole("dialog", { name: "Search resources" })).toHaveCount(0);
  }
  await session.window.locator(".freelens-power-settings-icon").click();
  const restoredSwitch = session.window
    .locator('label[data-testid="switch"]')
    .filter({ hasText: /Enable resource search/ });
  await expect(restoredSwitch.locator("input")).not.toBeChecked();
  await restoredSwitch.click();
  await closeSettings();
  const restoredSearch = await openSearch(activeFrame);
  await restoredSearch.getByRole("button", { name: "Close resource search" }).click();
});
