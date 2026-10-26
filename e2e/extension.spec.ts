import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Frame, type Locator, type TestInfo, test } from "@playwright/test";
import { FreelensSession } from "./app";
import { applyFixtures, mutateConfigMap, secretSentinel } from "./fixtures";
import { applyPowerLogsFixtures, logsDaemonSet, logsDeployment, logsSecretSentinel } from "./power-logs-fixtures";

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
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).click();
  await dialog.getByRole("option", { name: "Service", exact: true }).click();
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
  await frame
    .getByRole("navigation", { name: "Diagnostics views" })
    .getByRole("button", { name: /^Pending/ })
    .click();
  await frame.getByRole("combobox", { name: "Pending pod", exact: true }).click();
  await frame.getByText("power-test / pending-workload", { exact: true }).click();
  await expect(frame.locator(".pending-heading")).toContainText("pending-workload");
  await frame
    .getByRole("navigation", { name: "Diagnostics views" })
    .getByRole("button", { name: /^Not ready/ })
    .click();
  await expect(
    frame.getByRole("navigation", { name: "Diagnostics views" }).getByRole("button", { name: /^Not ready/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await frame.getByRole("combobox", { name: "Not ready pod", exact: true }).click();
  await frame.getByText("power-test / unready-workload", { exact: true }).click();
  await expect(frame.locator(".pending-heading")).toContainText("unready-workload");
  await frame
    .getByRole("navigation", { name: "Diagnostics views" })
    .getByRole("button", { name: "Consumers", exact: true })
    .click();
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

extensionTest("AI resource attachment survives closing its drawer", async (session, frame, info) => {
  await session.window.locator(".freelens-power-settings-icon").click();
  const settings = session.window.locator(".freelens-power-preferences");
  const toggle = settings.locator('label[data-testid="switch"]').filter({ hasText: "Enable AI features" });
  if (!(await toggle.locator("input").isChecked())) await toggle.click();
  await session.window.locator('div[class*="close-button-module__closeButton--"][aria-label="Close"]').click();
  await frame.getByText("Workloads", { exact: true }).first().click();
  await frame.getByText("Pods", { exact: true }).first().click();
  const dialog = await openSearch(frame);
  await (await search(dialog, "ready-workload", "Deployment")).click();
  const drawer = frame.locator(".Drawer").filter({ hasText: "ready-workload" }).last();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Ask AI", exact: true }).click();
  const chat = frame.getByRole("complementary", { name: "AI assistant" });
  await expect(chat).toBeVisible();
  const finding = chat.getByRole("button", { name: "Remove diagnostic finding", exact: true });
  if (await finding.isVisible()) await finding.click();
  const resource = chat.getByLabel("Attached resource", { exact: true });
  await expect(resource).toContainText("ready-workload");
  const pin = chat.getByRole("button", { name: "Pin AI assistant", exact: true });
  const originalPin = await pin.locator("svg").getAttribute("viewBox");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(await pin.locator("svg").getAttribute("viewBox")).not.toBe(originalPin);
  await chat.getByRole("textbox", { name: "Message", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(resource).toContainText("ready-workload");
  await chat.getByText("Attached context", { exact: true }).click();
  const preview = chat.locator(".power-ai-context-preview > details pre");
  await expect(preview).toContainText("ready-workload");
  await expect(preview.locator('[data-token="key"]').first()).toBeVisible();
  await session.screenshot(info, "ai-retained-resource", frame);
  await chat.getByRole("button", { name: "Remove attached resource", exact: true }).click();
  await expect(resource).toHaveCount(0);
  await expect(preview).not.toContainText("ready-workload");
  await chat.getByRole("textbox", { name: "Message", exact: true }).focus();
  await expect(resource).toHaveCount(0);
});

extensionTest("Power Logs workload sources, captures, SQL and reviewed AI context", async (session, frame, info) => {
  test.setTimeout(600_000);
  const samplePodName = applyPowerLogsFixtures();
  const closeSettings = () =>
    session.window.locator('div[class*="close-button-module__closeButton--"][aria-label="Close"]').click();
  const openSettings = async () => {
    await session.window.locator(".freelens-power-settings-icon").click();
    const settings = session.window.locator(".freelens-power-preferences");
    await expect(settings).toBeVisible();
    return settings;
  };
  const settings = await openSettings();
  for (const label of ["Use Power Logs", "Enable AI features"]) {
    const toggle = settings.locator('label[data-testid="switch"]').filter({ hasText: label });
    if (!(await toggle.locator("input").isChecked())) await toggle.click();
    await expect(toggle.locator("input")).toBeChecked();
  }
  await closeSettings();
  const openDeployment = async (active: Frame) => {
    const dialog = await openSearch(active);
    await (await search(dialog, logsDeployment, "Deployment")).click();
    return active.locator(".Drawer").filter({ hasText: logsDeployment }).last();
  };
  let drawer = await openDeployment(frame);
  await drawer
    .locator(".MenuItem")
    .filter({ has: frame.locator("[data-power-logs-target]") })
    .click();
  const page = frame.getByTestId("power-logs-page");
  await expect(page).toBeVisible();
  await expect(page.getByRole("status")).toContainText("6 sources", { timeout: 120_000 });
  const sourceFilter = page.getByRole("combobox", { name: "Container source", exact: true });
  await sourceFilter.click();
  const sourceMenu = frame.getByRole("listbox");
  await expect(sourceMenu.locator(".power-logs-source-check .Icon")).toHaveCount(1);
  const menuFits = await sourceMenu.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth && el.scrollWidth <= el.clientWidth + 1;
  });
  expect(menuFits).toBe(true);
  await session.screenshot(info, "power-logs-source-selector");
  await sourceFilter.press("Escape");
  await page.getByRole("button", { name: "Open AI assistant", exact: true }).click();
  const initialAssistant = frame.getByRole("complementary", { name: "AI assistant" });
  await expect(initialAssistant).toBeVisible();
  await expect(initialAssistant.locator(".power-ai-message")).toHaveCount(0);
  await expect(initialAssistant.getByLabel("Selected diagnostic finding")).toContainText("Power Logs");
  await initialAssistant.getByRole("button", { name: "Close AI assistant", exact: true }).click();
  await page.locator(".power-logs-options > summary").click();
  const captureWindow = page.getByRole("combobox", { name: "Capture window", exact: true });
  await captureWindow.click();
  await frame.getByRole("option", { name: "5 minutes", exact: true }).click();
  await expect(page.locator(".power-logs-options")).toContainText("5 minutes");
  await captureWindow.press("ArrowDown");
  await expect(frame.getByRole("listbox")).toBeVisible();
  await captureWindow.press("Escape");
  await session.screenshot(info, "power-logs-capture-options");
  await page.getByRole("tab", { name: "Live view", exact: true }).click();
  await expect(page.locator(".power-logs-options")).not.toHaveAttribute("open", "");
  await session.screenshot(info, "power-logs-compact-workspace");
  await page.locator(".power-logs-options > summary").click();
  await page.getByText("Compact density", { exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".power-log-row")
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    )
    .toBe(20);
  await page.getByText("Compact density", { exact: true }).click();
  await session.window.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Capture logs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Native logs", exact: true })).toHaveCount(0);

  await expect(page.locator(".power-log-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const text = await page.locator(".power-logs-muted[role=status]").innerText();
      return /\/6 active sources/.test(text);
    })
    .toBe(true);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Search log messages").fill("fixture failure");
  await page.getByRole("combobox", { name: "Log level", exact: true }).click();
  await frame.getByRole("option", { name: "ERROR", exact: true }).click();
  await page.getByRole("combobox", { name: "Container source", exact: true }).click();
  await frame.getByRole("option").filter({ hasText: "All pods" }).filter({ hasText: "Container · sidecar" }).click();
  await expect(page.locator(".power-log-row .power-log-origin").first()).toContainText(logsDeployment);
  await expect(page.locator(".power-log-row").first()).toHaveAttribute("data-level", "error");
  await page.locator(".power-log-row").first().click();
  const detail = page.getByLabel("Log line details");
  await expect(detail).toContainText("Structured fields");
  const geometry = await page.evaluate((element) => {
    const stream = element.querySelector(".power-logs-stream")!.getBoundingClientRect();
    const detail = element.querySelector(".power-logs-detail")!.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    return {
      streamBottom: stream.bottom,
      detailTop: detail.top,
      detailLeft: detail.left,
      detailRight: detail.right,
      detailWidth: detail.width,
      width: stream.width,
      height: stream.height,
      right: stream.right,
      viewport,
      rows: element.querySelectorAll(".power-log-row").length,
      pageHeight: element.getBoundingClientRect().height,
      rootScroll: element.scrollHeight - element.clientHeight,
      footerButtons: element.querySelector(".power-logs-footer")?.querySelectorAll("button,input,select").length ?? 0,
    };
  });
  expect(geometry.width).toBeGreaterThan(100);
  expect(geometry.height).toBeGreaterThan(geometry.pageHeight * 0.5);
  expect(geometry.rootScroll).toBeLessThanOrEqual(1);
  expect(geometry.footerButtons).toBe(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.rows).toBeLessThan(50);
  expect(geometry.width).toBeGreaterThanOrEqual(400);
  expect(geometry.detailTop).toBeLessThan(geometry.streamBottom);
  expect(geometry.detailWidth).toBeGreaterThan(200);
  expect(geometry.detailRight).toBeLessThanOrEqual(geometry.viewport + 1);
  await session.screenshot(info, "power-logs-filtered-line");
  await page.getByRole("button", { name: "Open AI assistant", exact: true }).click();
  const assistant = frame.getByLabel("AI assistant", { exact: true });
  await expect(assistant).toBeVisible();
  const finding = assistant.getByLabel("Selected diagnostic finding");
  await expect(finding).toContainText("Log line");
  await finding.locator("summary").click();
  await expect(finding.locator("pre")).toContainText(logsDeployment);
  await expect(finding.locator("pre")).toContainText("[REDACTED]");
  await expect(finding.locator("pre")).not.toContainText(logsSecretSentinel);
  await assistant.getByText("Attached context", { exact: true }).click();
  await expect(assistant.locator(".power-ai-context-preview > details pre")).toContainText(logsDeployment);
  await expect(assistant.locator(".power-ai-message-user")).toHaveCount(0);
  await session.screenshot(info, "power-logs-attached-ai-context");
  await assistant.getByRole("button", { name: "Close AI assistant", exact: true }).click();
  await page.getByRole("tab", { name: "SQL", exact: true }).click();
  await page.getByRole("button", { name: "Capture logs", exact: true }).click();
  await expect(page.getByRole("tab", { name: "SQL" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".power-logs-results")).toContainText("fixture");
  await expect(page.locator('th[data-column="message"]')).toBeVisible();
  await expect(page.locator('th[data-column="pod"]')).toBeVisible();
  const sqlGeometry = await page.evaluate((element) => {
    const results = element.querySelector(".power-logs-results")!.getBoundingClientRect();
    const root = element.getBoundingClientRect();
    return {
      ratio: results.height / root.height,
      visible: results.bottom <= root.bottom,
      scroll: element.scrollHeight - element.clientHeight,
    };
  });
  expect(sqlGeometry.ratio).toBeGreaterThan(0.4);
  expect(sqlGeometry.visible).toBe(true);
  expect(sqlGeometry.scroll).toBeLessThanOrEqual(1);
  await session.screenshot(info, "power-logs-recent-logs");
  const sql = page.getByLabel("SQL query");
  const run = page.getByRole("button", { name: "Run query", exact: true });
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "SQL · Recent", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SQL · Errors", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SQL · Timeline", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "SQL · JSON", exact: true })).toBeVisible();
  await sql.fill("SELECT * FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200");
  await run.click();
  await expect(page.locator('th[data-column="fieldsJson"]')).toBeVisible();
  const pages = page.getByRole("navigation", { name: "SQL result pages" });
  await expect(pages).toBeVisible();
  const resultsBox = await page.locator(".power-logs-results").boundingBox();
  const pagesBox = await pages.boundingBox();
  expect(pagesBox!.y).toBeGreaterThanOrEqual(resultsBox!.y + resultsBox!.height);
  await pages.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(pages).toContainText("Page 2 /");
  await pages.getByRole("button", { name: "Previous page", exact: true }).click();
  await page.locator(".power-logs-results").evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const horizontal = await page.locator(".power-logs-results").evaluate((el) => ({
    left: el.scrollLeft,
    outer: el.closest(".power-logs")!.scrollWidth - el.closest(".power-logs")!.clientWidth,
  }));
  expect(horizontal.left).toBeGreaterThan(0);
  expect(horizontal.outer).toBeLessThanOrEqual(1);
  await page.locator("tbody tr").filter({ hasText: "fixture ready" }).first().click();
  const sqlDetails = page.getByRole("complementary", { name: "Log line details" });
  await expect(sqlDetails.locator(".power-log-json")).toContainText("fixture ready");
  await session.screenshot(info, "power-logs-sql-row-json");
  await sqlDetails.getByRole("button", { name: "Close line details", exact: true }).click();
  await expect(sqlDetails).toHaveCount(0);
  await page.locator(".power-logs-results").evaluate((el) => {
    el.scrollLeft = 0;
  });
  await sql.focus();
  expect(await sql.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");

  await sql.fill(
    "SELECT count(*) AS lines, count(DISTINCT pod) AS pods, count(DISTINCT container) AS containers FROM logs",
  );
  await run.click();
  await expect(page.locator(".power-logs-results tbody tr")).toHaveCount(1);
  const counts = await page.locator(".power-logs-results tbody td").allTextContents();
  expect(Number(counts[0])).toBeGreaterThan(0);
  expect(counts.slice(1)).toEqual(["3", "2"]);
  console.info("Power Logs: capture count verified for 3 pods and 2 containers");
  await sql.fill(
    "SELECT json_extract(fieldsJson, '$.message') AS extracted_message, count(*) AS lines FROM logs WHERE fieldsJson IS NOT NULL GROUP BY extracted_message ORDER BY extracted_message",
  );
  await run.click();
  await expect(page.locator(".power-logs-results")).toContainText("fixture failure");
  await expect(page.locator(".power-logs-results")).toContainText("fixture ready");
  console.info("Power Logs: JSON extraction query verified");
  await session.screenshot(info, "power-logs-capture-sql");
  await sql.fill(
    "WITH RECURSIVE numbers(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM numbers WHERE i < 1000000) SELECT sum(a.i * b.i) FROM numbers a CROSS JOIN numbers b",
  );
  await run.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(run).toBeEnabled();
  await sql.fill("SELECT count(*) AS reusable FROM logs");
  await run.click();
  await expect(page.locator(".power-logs-results th")).toHaveText("reusable");
  await expect(page.locator(".power-logs-results tbody td")).toHaveText(counts[0]);
  console.info("Power Logs: cancellation and subsequent query verified");
  const exportedPath = join(session.profile, "power-logs-export.ndjson");
  await session.app.evaluate(({ dialog }, destination) => {
    const scope = globalThis as typeof globalThis & { powerLogsOriginalSaveDialog?: typeof dialog.showSaveDialog };
    scope.powerLogsOriginalSaveDialog = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, exportedPath);
  try {
    await page.getByRole("button", { name: "Export JSON", exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return (await readFile(exportedPath, "utf8")).trim().split("\n").length;
        } catch {
          return 0;
        }
      })
      .toBe(Number(counts[0]));
    const exportedRows = (await readFile(exportedPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(exportedRows.map((row) => row.pod)).size).toBe(3);
    expect(new Set(exportedRows.map((row) => row.container)).size).toBe(2);
    expect(exportedRows.every((row) => typeof row.message === "string" && typeof row.podUid === "string")).toBe(true);
    console.info("Power Logs: real NDJSON export contents verified");
  } finally {
    await session.app.evaluate(({ dialog }) => {
      const scope = globalThis as typeof globalThis & { powerLogsOriginalSaveDialog?: typeof dialog.showSaveDialog };
      if (scope.powerLogsOriginalSaveDialog) dialog.showSaveDialog = scope.powerLogsOriginalSaveDialog;
      delete scope.powerLogsOriginalSaveDialog;
    });
  }
  const checkSnapshotDialog = async (action: string) => {
    const dialog = frame.getByTestId("confirmation-dialog");
    await expect(dialog).toBeVisible();
    const message = dialog.locator(".power-logs-confirmation");
    const layout = await message.evaluate((element) => {
      const box = element.closest(".box")!;
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--contentColor)";
      document.body.append(probe);
      const result = {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        background: getComputedStyle(box).backgroundColor,
        expectedBackground: getComputedStyle(probe).backgroundColor,
      };
      probe.remove();
      return result;
    });
    expect(layout.width).toBeGreaterThan(200);
    expect(layout.height).toBeLessThan(160);
    expect(layout.background).toBe(layout.expectedBackground);
    const button = dialog.getByRole("button", { name: action, exact: true });
    await expect(button.locator(".Icon")).toHaveCount(1);
    if (action === "Delete snapshot") {
      const colors = await button.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--colorError)";
        document.body.append(probe);
        const result = [
          getComputedStyle(element).backgroundColor,
          getComputedStyle(probe).backgroundColor,
          getComputedStyle(element).color,
        ];
        probe.remove();
        return result;
      });
      expect(colors[0]).toBe(colors[1]);
      expect(colors[2]).toBe("rgb(255, 255, 255)");
    }
    await session.screenshot(info, `snapshot-${action.replaceAll(" ", "-").toLowerCase()}`, frame);
  };
  const snapshotSelect = page.getByRole("combobox", { name: "Capture snapshot", exact: true });
  await snapshotSelect.click();
  const keepSnapshot = frame.getByRole("button", { name: `Keep snapshot ${logsDeployment}`, exact: true }).first();
  const snapshotRow = keepSnapshot.locator("..");
  const textBox = await snapshotRow.locator(".power-logs-option-text").boundingBox();
  const keepBox = await keepSnapshot.boundingBox();
  const deleteBox = await snapshotRow.locator("[data-capture-delete]").boundingBox();
  expect(keepBox!.x).toBeGreaterThanOrEqual(textBox!.x + textBox!.width);
  expect(deleteBox!.x - keepBox!.x - keepBox!.width).toBeLessThanOrEqual(16);
  const originalPin = await keepSnapshot.locator(".Icon").innerHTML();
  await keepSnapshot.click();
  await checkSnapshotDialog("Keep snapshot");
  await frame.getByRole("button", { name: "Cancel", exact: true }).click();
  await snapshotSelect.click();
  await keepSnapshot.click();
  await frame.getByRole("button", { name: "Keep snapshot", exact: true }).click();
  await snapshotSelect.click();
  const allowExpiration = frame
    .getByRole("button", { name: `Allow expiration for snapshot ${logsDeployment}`, exact: true })
    .first();
  await expect(allowExpiration).toHaveAttribute("aria-pressed", "true");
  expect(await allowExpiration.locator(".Icon").innerHTML()).not.toBe(originalPin);
  await allowExpiration.hover();
  const hoverColors = await allowExpiration.evaluate((element) => [
    getComputedStyle(element).color,
    getComputedStyle(element).backgroundColor,
  ]);
  expect(hoverColors[0]).not.toBe(hoverColors[1]);
  await allowExpiration.click();
  await checkSnapshotDialog("Allow expiration");
  await frame.getByRole("button", { name: "Allow expiration", exact: true }).click();
  await snapshotSelect.click();
  await snapshotSelect.fill(logsDeployment);
  await snapshotSelect.press("Alt+Delete");
  const deleteSnapshot = frame.getByRole("button", { name: `Delete snapshot ${logsDeployment}`, exact: true });
  await expect(deleteSnapshot).toHaveCount(1);
  await deleteSnapshot.hover();
  await expect(frame.getByRole("tooltip").filter({ hasText: "Delete snapshot (Alt+Delete)" })).toBeVisible();
  await expect(page.getByLabel("SQL query")).toBeEditable();
  await snapshotSelect.fill("");
  await snapshotSelect.press("Alt+Delete");
  await checkSnapshotDialog("Delete snapshot");
  await frame.getByRole("button", { name: "Delete snapshot", exact: true }).click();
  await expect(page.locator(".power-logs-results table")).toHaveCount(0);
  await page.getByRole("button", { name: "Capture logs", exact: true }).click();
  await expect(page.locator(".power-logs-results tbody tr")).not.toHaveCount(0);
  await snapshotSelect.click();
  await frame
    .getByRole("button", { name: `Delete snapshot ${logsDeployment}`, exact: true })
    .first()
    .click();
  await frame.getByRole("button", { name: "Delete snapshot", exact: true }).click();
  await expect(page.locator(".power-logs-results table")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "SQL" })).toBeVisible();
  const agentSearch = await openSearch(frame);
  await (await search(agentSearch, logsDaemonSet, "DaemonSet")).click();
  const agentDrawer = frame.locator(".Drawer").filter({ hasText: logsDaemonSet }).last();
  await agentDrawer
    .locator(".MenuItem")
    .filter({ has: frame.locator("[data-power-logs-target]") })
    .click();
  await expect(page.getByRole("status")).toContainText("1 sources");
  await page.getByRole("combobox", { name: "Container source", exact: true }).click();
  await expect(
    frame.getByRole("option").filter({ hasText: "All pods" }).filter({ hasText: "Container · agent" }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Container source", exact: true }).press("Escape");
  await expect(page.locator(".power-log-row").first()).toContainText("agent");
  await session.screenshot(info, "power-logs-daemonset");
  const containerSearch = await openSearch(frame);
  await (await search(containerSearch, samplePodName, "Pod")).click();
  const containerDrawer = frame.locator(".Drawer").filter({ hasText: samplePodName }).last();
  const podLogsMenu = containerDrawer.locator(".MenuItem").filter({ has: frame.locator("[data-power-logs-target]") });
  await podLogsMenu.hover();
  await podLogsMenu
    .locator(".SubMenu .MenuItem")
    .filter({ hasText: /^sidecar$/ })
    .click();
  await expect(page.getByRole("status")).toContainText("2 sources");
  await expect(page.locator(".power-logs-filters")).toContainText("All pods / sidecar");
  await expect(page.locator(".power-log-row").first()).toContainText(samplePodName);
  const visibleOrigins = await page.locator(".power-log-row .power-log-origin").allTextContents();
  expect(visibleOrigins.length).toBeGreaterThan(0);
  expect(visibleOrigins.every((origin) => origin === samplePodName)).toBe(true);
  const origin = page.locator(".power-log-origin").first();
  if (await origin.isVisible()) {
    await origin.hover();
    await expect(frame.getByRole("tooltip").filter({ hasText: `${samplePodName} / sidecar` })).toBeVisible();
  } else {
    const width = await page.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    });
    expect(width).toBeLessThanOrEqual(760);
    await expect(origin).toHaveCSS("display", "none");
  }
  await session.screenshot(info, "power-logs-pod-container");
  await page.getByRole("button", { name: "Native logs", exact: true }).click();
  const nativeDock = frame.locator(".Dock.isOpen");
  await expect(nativeDock).toBeVisible();
  const nativeTab = nativeDock.locator('[data-testid^="dock-tab-for-"]').filter({ hasText: `Pod ${samplePodName}` });
  await expect(nativeTab).toBeVisible();
  await expect(nativeDock.locator('[data-testid^="dock-tab-content-for-"]')).toBeVisible();
  const download = frame.getByTestId("download-logs-dropdown");
  await expect(download).toBeVisible();
  const nativeAccent = await download.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--primary)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).color, expected };
  });
  expect(nativeAccent.actual).toBe(nativeAccent.expected);
  await session.screenshot(info, "power-logs-native-fallback");
  await nativeTab.locator('[data-testid^="dock-tab-close-for-"]').click();
  console.info("Power Logs: DaemonSet, per-container Pod menu and native fallback verified");
  const disabledSettings = await openSettings();
  const toggle = disabledSettings.locator('label[data-testid="switch"]').filter({ hasText: "Use Power Logs" });
  await toggle.click();
  await expect(toggle.locator("input")).not.toBeChecked();
  await closeSettings();
  const podSearch = await openSearch(frame);
  await (await search(podSearch, samplePodName, "Pod")).click();
  drawer = frame.locator(".Drawer").filter({ hasText: samplePodName }).last();
  await expect(drawer.locator("[data-power-logs-target]")).toHaveCount(0);
  await expect(
    drawer.locator(".MenuItem").filter({ has: frame.locator(".title", { hasText: /^Logs$/ }) }),
  ).toBeVisible();
  await session.screenshot(info, "power-logs-native-restored");
  if (process.env.E2E_LANE === "extended") {
    await session.close(info, false);
    await session.start(info);
    await session.cluster(info);
    const persisted = await openSettings();
    await expect(
      persisted.locator('label[data-testid="switch"]').filter({ hasText: "Use Power Logs" }).locator("input"),
    ).not.toBeChecked();
    await expect(
      persisted.locator('label[data-testid="switch"]').filter({ hasText: "Enable AI features" }).locator("input"),
    ).toBeChecked();
    await closeSettings();
  }
});
