import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiApiKeyStatus, apiKeyStorageAvailable, readAiApiKey, setAiApiKey } from "./ai-api-key";

const mocks = vi.hoisted(() => ({
  root: "",
  available: true,
  backend: "keychain",
  encrypt: vi.fn((value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`)),
  decrypt: vi.fn((value: Buffer) => {
    const text = value.toString();
    if (!text.startsWith("encrypted:")) throw new Error("Invalid encrypted data");
    return Buffer.from(text.slice(10), "base64").toString();
  }),
}));
vi.mock("electron", () => ({
  app: { getPath: () => mocks.root },
  safeStorage: {
    isEncryptionAvailable: () => mocks.available,
    getSelectedStorageBackend: () => mocks.backend,
    encryptString: mocks.encrypt,
    decryptString: mocks.decrypt,
  },
}));
const key = "sk-example-test-key-not-real-123456789";

beforeEach(async () => {
  mocks.root = await mkdtemp(join(tmpdir(), "ai-api-key-"));
  mocks.available = true;
  mocks.backend = "keychain";
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(mocks.root, { recursive: true, force: true });
});

it("stores only encrypted bytes in a private file and returns status without exposing the key", async () => {
  expect(await aiApiKeyStatus()).toEqual({ configured: false, available: true });
  expect(await setAiApiKey(key)).toEqual({ configured: true, available: true });
  const root = join(mocks.root, "freelens-power-secrets");
  const path = join(root, "openai-api-key.bin");
  expect((await lstat(root)).mode & 0o777).toBe(0o700);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await readFile(path)).toString()).not.toContain(key);
  expect(mocks.encrypt).toHaveBeenCalledWith(key);
  expect(await readAiApiKey()).toBe(key);
  expect(await setAiApiKey("")).toEqual({ configured: false, available: true });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses unavailable encryption and Linux plaintext storage without falling back to normal settings", async () => {
  mocks.available = false;
  expect(await aiApiKeyStatus()).toEqual({ configured: false, available: false });
  await expect(setAiApiKey(key)).rejects.toThrow("Secure API key storage is unavailable");
  expect(mocks.encrypt).not.toHaveBeenCalled();
  mocks.available = true;
  mocks.backend = "basic_text";
  expect(apiKeyStorageAvailable("linux")).toBe(false);
});

it("does not read public, oversized, corrupted or symlinked credential files", async () => {
  await setAiApiKey(key);
  const path = join(mocks.root, "freelens-power-secrets", "openai-api-key.bin");
  await chmod(path, 0o644);
  expect(await readAiApiKey()).toBe("");
  await chmod(path, 0o600);
  await writeFile(path, Buffer.alloc(8193));
  expect(await readAiApiKey()).toBe("");
  await writeFile(path, "corrupted");
  expect(await readAiApiKey()).toBe("");
  await rm(path);
  const linked = join(mocks.root, "linked.bin");
  await writeFile(linked, mocks.encrypt(key), { mode: 0o600 });
  await symlink(linked, path);
  expect(await readAiApiKey()).toBe("");
  await setAiApiKey("");
  expect((await readFile(linked)).length).toBeGreaterThan(0);
});

it("serializes updates and rejects invalid values without echoing submitted material", async () => {
  await expect(setAiApiKey("invalid key with spaces")).rejects.toThrow("Invalid API key");
  await Promise.all([setAiApiKey(key), setAiApiKey("")]);
  expect(await aiApiKeyStatus()).toEqual({ configured: false, available: true });
});

it("accepts Windows synthesized permission bits while retaining encrypted storage", async () => {
  await setAiApiKey(key);
  const path = join(mocks.root, "freelens-power-secrets", "openai-api-key.bin");
  await chmod(path, 0o666);
  expect(await readAiApiKey("linux")).toBe("");
  expect(await readAiApiKey("win32")).toBe(key);
  expect(mocks.decrypt).toHaveBeenCalled();
  expect((await readFile(path)).toString()).not.toContain(key);
});
