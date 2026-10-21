// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DashboardSiteIcon } from "../common/dashboard-views";

const maxBytes = 2 * 1024 * 1024;

export function boundedDashboardIcons(value: unknown): DashboardSiteIcon[] {
  if (!Array.isArray(value)) return [];
  const result: DashboardSiteIcon[] = [];
  let bytes = 2;
  for (const entry of value.slice(0, 32)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, pageUrl, dataUrl } = entry;
    if (
      typeof id !== "string" ||
      id.length > 200 ||
      typeof pageUrl !== "string" ||
      pageUrl.length > 4096 ||
      typeof dataUrl !== "string" ||
      dataUrl.length > 700_000 ||
      !/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        dataUrl,
      )
    )
      continue;
    if (Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64").length > 524288) continue;
    try {
      const url = new URL(pageUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    } catch {
      continue;
    }
    const icon = { id, pageUrl, dataUrl };
    const size = Buffer.byteLength(JSON.stringify(icon)) + 1;
    if (bytes + size > maxBytes) continue;
    result.push(icon);
    bytes += size;
  }
  return result;
}

export async function loadDashboardIcons(path: string): Promise<DashboardSiteIcon[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    if ((await file.stat()).size > maxBytes) return [];
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return [];
    return boundedDashboardIcons(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

export async function saveDashboardIcons(path: string, icons: DashboardSiteIcon[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(boundedDashboardIcons(icons)), { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
