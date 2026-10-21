import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyClaudeMdmFiles, verifyClaudePolicyFiles } from "./ai-claude-policy";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

it("rejects managed hooks, executable settings and unverifiable policy files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-policy-"));
  const file = join(directory, "managed-settings.json");
  try {
    await expect(verifyClaudePolicyFiles([file])).resolves.toBeUndefined();
    await writeFile(file, "{}");
    await expect(verifyClaudePolicyFiles([file])).resolves.toBeUndefined();
    for (const policy of [
      { hooks: { SessionStart: [] } },
      { disableAllHooks: true, policyHelper: "example-helper" },
      { disableAllHooks: true, apiKeyHelper: "example-helper" },
      { disableAllHooks: true, env: { EXAMPLE: "value" } },
      { env: { NODE_OPTIONS: "--require=example" } },
      { env: { BUN_OPTIONS: "--preload=example" } },
      { env: { CLAUDE_CODE_SYSTEM_PROMPT: "example" } },
      { env: { ANTHROPIC_API_KEY: 123 } },
      { env: [] },
      { hooks: [] },
      [],
    ]) {
      await writeFile(file, JSON.stringify(policy));
      await expect(verifyClaudePolicyFiles([file])).rejects.toThrow("managed policy");
    }
    await writeFile(file, "invalid");
    await expect(verifyClaudePolicyFiles([file])).rejects.toThrow("managed policy");
    for (const policy of [
      { disableAllHooks: true },
      { model: "sonnet" },
      { hooks: {}, permissions: { deny: ["Bash"] } },
      { disableAllHooks: true, hooks: { SessionStart: [] } },
      {
        permissions: { deny: ["Bash"] },
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "0",
          DISABLE_ERROR_REPORTING: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_BUG_COMMAND: "1",
          DISABLE_FEEDBACK_COMMAND: "1",
          DISABLE_TELEMETRY: "1",
          ANTHROPIC_API_KEY: "example-key",
          ANTHROPIC_BASE_URL: "https://example.invalid",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "example-model",
          HTTP_PROXY: "http://example.invalid",
          NODE_EXTRA_CA_CERTS: "example-ca.pem",
        },
      },
    ]) {
      await writeFile(file, JSON.stringify(policy));
      await expect(verifyClaudePolicyFiles([file])).resolves.toBeUndefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("converts existing MDM files with a bounded native command and validates their policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-mdm-"));
  const file = join(directory, "example-policy.plist");
  await writeFile(file, "example plist");
  let output = JSON.stringify({
    allowedHttpHookUrls: [],
    permissions: { deny: ["Bash"] },
    env: { ANTHROPIC_API_KEY: "example-key", CLAUDE_CODE_ENABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "1" },
    disableRemoteControl: true,
  });
  let failure: Error | null = null;
  execFileMock.mockImplementation((_command, _args, _options, callback) => callback(failure, output));
  try {
    await expect(verifyClaudeMdmFiles([file])).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenLastCalledWith(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", file],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 3000, shell: false, env: {} },
      expect.any(Function),
    );
    for (const policy of [
      { hooks: { SessionStart: [] } },
      { disableAllHooks: true, policyHelper: "example-helper" },
      { env: { NODE_OPTIONS: "--require=example" } },
    ]) {
      output = JSON.stringify(policy);
      await expect(verifyClaudeMdmFiles([file])).rejects.toThrow("managed policy");
    }
    output = "invalid";
    await expect(verifyClaudeMdmFiles([file])).rejects.toThrow("managed policy");
    output = " ".repeat(1024 * 1024 + 1);
    await expect(verifyClaudeMdmFiles([file])).rejects.toThrow("managed policy");
    failure = new Error("example conversion failure");
    await expect(verifyClaudeMdmFiles([file])).rejects.toThrow("managed policy");
    execFileMock.mockClear();
    await expect(verifyClaudeMdmFiles([join(directory, "missing.plist")])).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  } finally {
    execFileMock.mockReset();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects split policies that would reenable managed hooks after merging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-policy-merge-"));
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  try {
    await writeFile(first, JSON.stringify({ disableAllHooks: true, hooks: { SessionStart: [] } }));
    for (const disableAllHooks of [false, null, "true", 1]) {
      await writeFile(second, JSON.stringify({ disableAllHooks }));
      await expect(verifyClaudePolicyFiles([first, second])).rejects.toThrow("managed policy");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
