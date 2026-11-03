import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage } from "electron";

import type { AiApiKeyStatus } from "../common/ai";

let pending: Promise<unknown> = Promise.resolve();

export function apiKeyStorageAvailable(platform: NodeJS.Platform = process.platform): boolean {
  try {
    return Boolean(
      safeStorage?.isEncryptionAvailable() &&
        (platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    );
  } catch {
    return false;
  }
}

function directory(): string {
  return join(app.getPath("userData"), "freelens-power-secrets");
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = pending.then(operation);
  pending = next.catch(() => {});
  return next;
}

async function readKey(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (!apiKeyStorageAvailable(platform)) return "";
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(directory(), "openai-api-key.bin"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 8192 || (platform !== "win32" && (metadata.mode & 0o077) !== 0))
      return "";
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) return "";
    const key = safeStorage.decryptString(buffer.subarray(0, bytesRead));
    return validKey(key) ? key : "";
  } catch {
    return "";
  } finally {
    await file?.close().catch(() => {});
  }
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{20,512}$/.test(value);
}

export function readAiApiKey(platform: NodeJS.Platform = process.platform): Promise<string> {
  return serialized(() => readKey(platform));
}

export function aiApiKeyStatus(): Promise<AiApiKeyStatus> {
  return serialized(async () => ({ available: apiKeyStorageAvailable(), configured: Boolean(await readKey()) }));
}

export function setAiApiKey(value: unknown): Promise<AiApiKeyStatus> {
  return serialized(async () => {
    if (typeof value !== "string" || (value !== "" && !validKey(value))) throw new Error("Invalid API key");
    if (value === "") {
      await rm(join(directory(), "openai-api-key.bin"), { force: true });
    } else {
      if (!apiKeyStorageAvailable()) throw new Error("Secure API key storage is unavailable");
      let temporary: string | undefined;
      try {
        const root = directory();
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (!(await lstat(root)).isDirectory()) throw new Error("Unavailable storage directory");
        await chmod(root, 0o700);
        temporary = await mkdtemp(join(root, ".api-key-"));
        const path = join(temporary, "key.bin");
        await writeFile(path, safeStorage.encryptString(value), { mode: 0o600, flag: "wx" });
        await rename(path, join(root, "openai-api-key.bin"));
      } catch {
        throw new Error("Could not save API key securely");
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    }
    return { available: apiKeyStorageAvailable(), configured: Boolean(await readKey()) };
  });
}
