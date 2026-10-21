import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const policyFailure =
  "Claude managed policy cannot be safely isolated. Use Codex or ask your administrator to disable managed hooks and command helpers";
const maxPolicyBytes = 1024 * 1024;
const allowedPolicyEnvironment = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_BUG_COMMAND",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_TELEMETRY",
]);

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(policyFailure);
  }
}

export function validateClaudeManagedPolicy(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(policyFailure);
  const policy = value as Record<string, unknown>;
  if ("disableAllHooks" in policy && policy.disableAllHooks !== true) throw new Error(policyFailure);
  if ("hooks" in policy) {
    if (!policy.hooks || typeof policy.hooks !== "object" || Array.isArray(policy.hooks))
      throw new Error(policyFailure);
    if (Object.keys(policy.hooks).length > 0 && policy.disableAllHooks !== true) throw new Error(policyFailure);
  }
  if ("env" in policy) {
    if (!policy.env || typeof policy.env !== "object" || Array.isArray(policy.env)) throw new Error(policyFailure);
    for (const [key, value] of Object.entries(policy.env))
      if (!allowedPolicyEnvironment.has(key) || typeof value !== "string") throw new Error(policyFailure);
  }
  for (const key of [
    "policyHelper",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "proxyAuthHelper",
    "otelHeadersHelper",
    "statusLine",
    "fileSuggestion",
    "fileSuggestionCommand",
  ])
    if (key in policy) throw new Error(policyFailure);
}

export async function verifyClaudePolicyFiles(files: string[], directory?: string): Promise<void> {
  const paths = [...files];
  if (directory && (await present(directory))) {
    const entries = await readdir(directory);
    if (entries.length > 100) throw new Error(policyFailure);
    paths.push(
      ...entries
        .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
        .sort()
        .map((name) => join(directory, name)),
    );
  }
  for (const path of paths) {
    if (!(await present(path))) continue;
    const file = await open(path, "r");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > maxPolicyBytes) throw new Error(policyFailure);
      const buffer = Buffer.alloc(maxPolicyBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxPolicyBytes) throw new Error(policyFailure);
      const policy = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      validateClaudeManagedPolicy(policy);
    } catch {
      throw new Error(policyFailure);
    } finally {
      await file.close();
    }
  }
}

export async function verifyClaudeMdmFiles(files: string[]): Promise<void> {
  for (const file of files) {
    if (!(await present(file))) continue;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", "--", file],
        { encoding: "utf8", maxBuffer: maxPolicyBytes, timeout: 3000, shell: false, env: {} },
        (error, stdout) => {
          if (error) reject(new Error(policyFailure));
          else resolve(stdout);
        },
      );
    });
    try {
      if (Buffer.byteLength(output, "utf8") > maxPolicyBytes) throw new Error(policyFailure);
      validateClaudeManagedPolicy(JSON.parse(output));
    } catch {
      throw new Error(policyFailure);
    }
  }
}

export async function verifyClaudeManagedPolicy(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(policyFailure);
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) throw new Error(policyFailure);
  if (process.platform === "darwin") {
    const username = userInfo().username;
    await verifyClaudeMdmFiles([
      join("/Library/Managed Preferences", "com.anthropic.claudecode.plist"),
      join("/Library/Managed Preferences", username, "com.anthropic.claudecode.plist"),
    ]);
  }
  const directory = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
  // native safe mode still honors managed policy, including its cached server policy
  await verifyClaudePolicyFiles(
    [join(directory, "managed-settings.json"), join(homedir(), ".claude", "remote-settings.json")],
    join(directory, "managed-settings.d"),
  );
}
