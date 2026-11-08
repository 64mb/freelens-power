import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHotbarCount } from "./hotbar-count";

it("reads only the hotbar count and tolerates missing, invalid or oversized native settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "power-hotbar-count-"));
  const path = join(directory, "hotbars.json");
  try {
    expect(await readHotbarCount(path)).toBe(1);
    await writeFile(path, JSON.stringify({ hotbars: [{ id: "one" }, { id: "two" }, { id: "one" }, null] }));
    expect(await readHotbarCount(path)).toBe(2);
    await writeFile(path, "invalid");
    expect(await readHotbarCount(path)).toBe(1);
    await writeFile(path, " ".repeat(2 * 1024 * 1024 + 1));
    expect(await readHotbarCount(path)).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
