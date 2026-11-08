import { open } from "node:fs/promises";

export async function readHotbarCount(path: string): Promise<number> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const limit = 2 * 1024 * 1024;
    const size = (await file.stat()).size;
    if (size > limit) return 1;
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) return 1;
    const data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!Array.isArray(data?.hotbars)) return 1;
    return new Set(
      data.hotbars
        .filter((bar: unknown) => bar && typeof bar === "object" && "id" in bar && typeof bar.id === "string")
        .map((bar: { id: string }) => bar.id),
    ).size;
  } catch {
    return 1;
  } finally {
    await file?.close();
  }
}
