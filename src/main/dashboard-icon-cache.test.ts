// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boundedDashboardIcons, loadDashboardIcons, saveDashboardIcons } from "./dashboard-icon-cache";

const icon = { id: "site", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" };

it("persists discovered image data across restarts and rejects invalid or oversized cache files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dashboard-icons-"));
  const path = join(directory, "icons.json");
  try {
    expect(await loadDashboardIcons(path)).toEqual([]);
    await saveDashboardIcons(path, [icon]);
    expect(await loadDashboardIcons(path)).toEqual([icon]);
    await writeFile(path, "invalid");
    expect(await loadDashboardIcons(path)).toEqual([]);
    await writeFile(path, " ".repeat(2 * 1024 * 1024 + 1));
    expect(await loadDashboardIcons(path)).toEqual([]);
    await saveDashboardIcons(
      path,
      Array.from({ length: 64 }, (_, index) => ({ ...icon, id: String(index) })),
    );
    expect(await loadDashboardIcons(path)).toHaveLength(32);
    expect((await readFile(path)).length).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds total stored data and excludes non-images, credentials and oversized images", () => {
  const large = { ...icon, dataUrl: `data:image/png;base64,${Buffer.alloc(524288).toString("base64")}` };
  expect(
    boundedDashboardIcons(Array.from({ length: 32 }, (_, index) => ({ ...large, id: String(index) }))),
  ).toHaveLength(2);
  expect(
    boundedDashboardIcons([
      { ...icon, dataUrl: "https://example.com/favicon.ico" },
      { ...icon, dataUrl: "data:text/html;base64,AQID" },
      { ...icon, pageUrl: "https://user:password@example.com/" },
      { ...large, dataUrl: `data:image/png;base64,${Buffer.alloc(524289).toString("base64")}` },
    ]),
  ).toEqual([]);
});
