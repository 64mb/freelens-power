import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PI_REASONING_EFFORTS } from "../common/ai-models";

class PiMissingCredentialError extends Error {}

export function piAiArguments(
  model: string,
  reasoningEffort = "",
  responseSchema?: unknown,
  extensionPath?: string,
): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._/+-]{0,250}$/.test(model))
    throw new Error("Invalid Pi model");
  if (reasoningEffort && !(PI_REASONING_EFFORTS as readonly string[]).includes(reasoningEffort))
    throw new Error("Invalid Pi reasoning effort");
  const args = [
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--offline",
    "--no-approve",
    "--model",
    model,
  ];
  if (extensionPath) args.push("--extension", extensionPath, "--tools", "freelens_response");
  if (reasoningEffort) args.push("--thinking", reasoningEffort);
  if (responseSchema !== undefined)
    args.push(
      "--system-prompt",
      `You are a read-only assistant. No built-in tools are available. Always return exactly one JSON object matching this schema, putting tool before text. Any user-requested wording or answer format applies only inside the text field. Never omit the JSON envelope, and never add markdown fences or other text outside it: ${JSON.stringify(responseSchema)}`,
    );
  return args;
}

export async function writePiResponseExtension(directory: string, responseSchema: unknown): Promise<string> {
  const path = join(directory, "freelens-response.mjs");
  await writeFile(
    path,
    `export default function(pi) {
    pi.registerTool({
      name: "freelens_response", label: "Submit response",
      description: "Submit the response JSON. Always call this tool to return either bounded read requests or your final answer. User answer formatting applies only inside text.",
      parameters: ${JSON.stringify(responseSchema)},
      async execute(_id, params) {
        return { content: [{ type: "text", text: "Response submitted" }], details: { freelensResponse: params }, terminate: true };
      }
    });
    pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.api === "openai-completions")
        return { ...event.payload, tool_choice: { type: "function", function: { name: "freelens_response" } } };
    });
  }`,
    { mode: 0o600 },
  );
  return path;
}

export function piAiEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "USER",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "ANT_LING_API_KEY",
    "NVIDIA_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "OPENCODE_API_KEY",
    "RADIUS_API_KEY",
    "TYPESAFE_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "BASETEN_API_KEY",
    "KIMI_API_KEY",
    "META_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MOONSHOT_API_KEY",
    "QWEN_TOKEN_PLAN_API_KEY",
    "QWEN_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    if (typeof source[key] === "string") environment[key] = source[key];
  environment.PI_TELEMETRY = "0";
  environment.PI_SKIP_VERSION_CHECK = "1";
  return environment;
}

// copy credentials and model definitions without loading user settings, packages or executable credential commands
export async function preparePiAiEnvironment(
  directory: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = piAiEnvironment(source);
  const original = source.PI_CODING_AGENT_DIR || join(source.HOME || homedir(), ".pi", "agent");
  const isolated = join(directory, "pi-agent");
  await mkdir(isolated, { recursive: true, mode: 0o700 });
  environment.HOME = join(isolated, "home");
  await mkdir(environment.HOME, { recursive: true, mode: 0o700 });
  environment.AWS_CONFIG_FILE = join(isolated, "disabled-aws-config");
  environment.AWS_SHARED_CREDENTIALS_FILE = join(isolated, "disabled-aws-credentials");
  environment.AWS_EC2_METADATA_DISABLED = "true";
  environment.CLOUDSDK_CONFIG = join(isolated, "disabled-gcloud");
  environment.GOOGLE_APPLICATION_CREDENTIALS = join(isolated, "disabled-google-credentials.json");
  environment.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES = "0";
  for (const name of ["auth.json", "models.json"]) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(join(original, name), "r");
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Invalid Pi configuration");
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error("Invalid Pi configuration");
      const config: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid Pi configuration");
      const credentialValue = (value: string, localEnv: unknown): string => {
        if (value.startsWith("!")) throw new Error("Pi command credentials are unavailable in read-only mode");
        const resolved = value.replace(
          /\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
          (_match, escaped: string, braced: string, plain: string) => {
            if (escaped === "$" || escaped === "!") return escaped;
            const key = braced || plain;
            const local =
              localEnv && typeof localEnv === "object" ? (localEnv as Record<string, unknown>)[key] : undefined;
            const found = (typeof local === "string" && local) || source[key];
            if (!found) throw new PiMissingCredentialError();
            return found;
          },
        );
        // the Pi CLI resolves these fields again, so preserve literal [$] and a leading [!] with its escape syntax
        return resolved.replace(/\$/g, () => "$$").replace(/^!/, "$!");
      };
      const resolve = (value: unknown, field = "", localEnv?: unknown): unknown => {
        if (typeof value === "string")
          return field === "apiKey" || field === "credential" || field === "header"
            ? credentialValue(value, localEnv)
            : value;
        if (Array.isArray(value)) return value.map((entry) => resolve(entry, field, localEnv));
        if (value && typeof value === "object") {
          const object = value as Record<string, unknown>;
          if (field === "env") {
            // retain only explicit provider token variables, never SDK profiles or credential helper paths
            return Object.fromEntries(
              Object.entries(object).filter(
                ([key, entry]) =>
                  typeof entry === "string" &&
                  /(?:_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(?:HF_TOKEN|COPILOT_GITHUB_TOKEN)$/.test(key) &&
                  Object.hasOwn(piAiEnvironment({ [key]: entry }), key),
              ),
            );
          }
          const entries: [string, unknown][] = [];
          for (const [key, entry] of Object.entries(object)) {
            try {
              entries.push([
                key,
                resolve(
                  entry,
                  field === "headers" ? "header" : key === "key" && object.type === "api_key" ? "credential" : key,
                  object.env ?? localEnv,
                ),
              ]);
            } catch (error) {
              // a missing optional model [apiKey] can fall back to stored auth or provider token variables
              if (!(error instanceof PiMissingCredentialError) || name !== "models.json" || key !== "apiKey")
                throw error;
            }
          }
          return Object.fromEntries(entries);
        }
        return value;
      };
      const configured = config as Record<string, unknown>;
      const providers = name === "models.json" ? configured.providers : configured;
      const available: Record<string, unknown> = {};
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [provider, definition] of Object.entries(providers)) {
          try {
            available[provider] = resolve(definition);
          } catch (error) {
            if (!(error instanceof PiMissingCredentialError)) throw error;
          }
        }
      }
      if (name === "models.json") {
        for (const provider of Object.values(available)) {
          if (!provider || typeof provider !== "object") continue;
          type ModelMapping = { id?: string; api?: string; thinkingLevelMap?: Record<string, unknown> };
          const definition = provider as {
            api?: string;
            models?: ModelMapping[];
            modelOverrides?: Record<string, ModelMapping>;
          };
          const models: [string | undefined, ModelMapping][] = [
            ...(Array.isArray(definition.models)
              ? definition.models.map((model): [string | undefined, ModelMapping] => [model.id, model])
              : []),
            ...Object.entries(definition.modelOverrides ?? {}),
          ];
          for (const [id, model] of models) {
            if ((model.api ?? definition.api) !== "openai-completions") continue;
            const defaults =
              id?.split("/").at(-1) === "deepseek-v4-flash"
                ? {
                    off: "none",
                    minimal: "minimal",
                    low: "low",
                    medium: "medium",
                    high: "high",
                    xhigh: "xhigh",
                    max: null,
                  }
                : id?.split("/").at(-1) === "glm-5-3"
                  ? { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }
                  : undefined;
            if (defaults) model.thinkingLevelMap = { ...defaults, ...model.thinkingLevelMap };
          }
        }
      }
      const resolved = name === "models.json" ? { ...configured, providers: available } : available;
      await writeFile(join(isolated, name), JSON.stringify(resolved), { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await file?.close();
    }
  }
  environment.PI_CODING_AGENT_DIR = isolated;
  return environment;
}

function canonicalPiValue(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, normalize((entry as Record<string, unknown>)[key])]),
          )
        : entry;
  return JSON.stringify(normalize(value));
}

export class PiResponseRelay {
  hasCalls = false;
  response: unknown;
  private call: { id: string; arguments: unknown } | undefined;
  private started = false;
  private completed = false;
  private invalid = false;

  accept(event: ReturnType<typeof JSON.parse>): unknown {
    const fail = () => {
      this.invalid = true;
      throw new Error("CLI request failed. Check CLI authentication and model access");
    };
    if (this.invalid) fail();
    if (
      event.type === "agent_start" ||
      (event.type === "message_start" && event.message?.role === "assistant") ||
      event.type === "error" ||
      (event.type === "message_update" && event.assistantMessageEvent?.type === "error")
    ) {
      this.call = undefined;
      this.started = false;
      this.completed = false;
      this.response = undefined;
    }
    const item = event.assistantMessageEvent;
    if (event.type === "message_update" && typeof item?.type === "string" && item.type.startsWith("toolcall")) {
      this.hasCalls = true;
      if (
        (item.type === "toolcall_start" && item.toolName !== "freelens_response") ||
        (item.type === "toolcall_end" && item.toolCall?.name !== "freelens_response")
      )
        fail();
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const calls = Array.isArray(event.message.content)
        ? event.message.content.filter((block: { type?: string }) => block?.type === "toolCall")
        : [];
      if (calls.length) {
        this.hasCalls = true;
        const call = calls[0];
        if (
          event.message.stopReason !== "toolUse" ||
          calls.length !== 1 ||
          call.name !== "freelens_response" ||
          typeof call.id !== "string" ||
          !call.arguments ||
          typeof call.arguments !== "object" ||
          Array.isArray(call.arguments) ||
          this.call !== undefined
        )
          fail();
        this.call = { id: call.id, arguments: call.arguments };
      }
    }
    if (event.type === "tool_execution_start") {
      this.hasCalls = true;
      if (
        event.toolName !== "freelens_response" ||
        !this.call ||
        event.toolCallId !== this.call.id ||
        this.started ||
        canonicalPiValue(event.args) !== canonicalPiValue(this.call.arguments)
      )
        fail();
      this.started = true;
    }
    if (
      event.type === "tool_execution_update" &&
      (event.toolName !== "freelens_response" || !this.started || event.toolCallId !== this.call?.id)
    )
      fail();
    if (event.type === "tool_execution_end") {
      this.hasCalls = true;
      if (
        event.toolName !== "freelens_response" ||
        !this.started ||
        !this.call ||
        event.toolCallId !== this.call.id ||
        event.isError !== false ||
        this.completed ||
        !event.result?.details ||
        !Object.hasOwn(event.result.details, "freelensResponse") ||
        canonicalPiValue(event.result.details.freelensResponse) !== canonicalPiValue(this.call.arguments)
      )
        fail();
      this.completed = true;
      this.response = event.result.details.freelensResponse;
      return this.response;
    }
    return undefined;
  }
}

export function piAiOutputText(output: string): string {
  let text: string | undefined;
  let settled = false;
  let providerFailed = false;
  const relay = new PiResponseRelay();
  for (const line of output.split("\n").filter((line) => line.trim())) {
    const event = JSON.parse(line);
    relay.accept(event);
    const item = event.assistantMessageEvent;
    if (event.type === "error" || (event.type === "message_update" && item?.type === "error")) {
      text = undefined;
      providerFailed = true;
    }
    if (event.type === "agent_start") {
      settled = false;
      text = undefined;
      providerFailed = false;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      text = undefined;
      settled = false;
      providerFailed = false;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      providerFailed = message.stopReason === "error";
      text =
        message.stopReason === "stop" &&
        Array.isArray(message.content) &&
        message.content.every(
          (block: { type?: string; text?: unknown }) =>
            block?.type === "thinking" || (block?.type === "text" && typeof block.text === "string"),
        )
          ? message.content
              .filter((block: { type: string }) => block.type === "text")
              .map((block: { text: string }) => block.text)
              .join("")
          : undefined;
    }
    if (event.type === "agent_settled") {
      if (event.aborted !== false) throw new Error("AI returned an incomplete response");
      settled = true;
    }
  }
  if (settled && providerFailed) throw new Error("CLI request failed. Check CLI authentication and model access");
  if (!settled) throw new Error("AI returned an incomplete response");
  if (relay.hasCalls) {
    if (relay.response === undefined) throw new Error("AI returned an incomplete response");
    return JSON.stringify(relay.response);
  }
  if (!text) throw new Error("AI returned an incomplete response");
  return text;
}

export function piAiOutputDiagnostics(output: string) {
  let records = 0;
  let malformedRecords = 0;
  let assistantMessages = 0;
  let stopReason = "missing";
  let settled: boolean | null = null;
  let textLength = 0;
  let textFormat = "empty";
  let nativeToolCalls = 0;
  let providerErrors = 0;
  let textType = "missing";
  let toolType = "missing";
  let toolMethod = "missing";
  let unknownFieldCount = 0;
  for (const line of output.split("\n").filter((line) => line.trim())) {
    let event: ReturnType<typeof JSON.parse>;
    try {
      event = JSON.parse(line);
      if (!event || typeof event !== "object") throw new Error();
    } catch {
      malformedRecords++;
      continue;
    }
    records++;
    if (event.type === "agent_settled") settled = event.aborted === false;
    if (event.type === "error" || (event.type === "message_update" && event.assistantMessageEvent?.type === "error"))
      providerErrors++;
    if (
      event.type === "tool_execution_start" ||
      (event.type === "message_update" &&
        typeof event.assistantMessageEvent?.type === "string" &&
        event.assistantMessageEvent.type.startsWith("toolcall"))
    )
      nativeToolCalls++;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      assistantMessages++;
      stopReason = ["stop", "length", "toolUse", "error", "aborted"].includes(event.message.stopReason)
        ? event.message.stopReason
        : "unknown";
      const text = Array.isArray(event.message.content)
        ? event.message.content
            .filter(
              (block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string",
            )
            .map((block: { text: string }) => block.text)
            .join("")
        : "";
      textLength = text.length;
      textFormat = !text ? "empty" : /^\s*```/.test(text) ? "markdown" : "other";
      try {
        const envelope = JSON.parse(text);
        textFormat = "json";
        if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
          textType = envelope.text === null ? "null" : typeof envelope.text;
          toolType = envelope.tool === null ? "null" : Array.isArray(envelope.tool) ? "array" : typeof envelope.tool;
          const method = envelope.tool?.method;
          toolMethod = ["pods", "nodes", "resources", "logs"].includes(method)
            ? method
            : method === undefined
              ? "missing"
              : "unknown";
          unknownFieldCount = Object.keys(envelope).filter((key) => key !== "tool" && key !== "text").length;
        }
      } catch {
        /* only response shape is diagnostic */
      }
    }
  }
  return {
    records,
    malformedRecords,
    assistantMessages,
    stopReason,
    settled,
    textLength,
    textFormat,
    nativeToolCalls,
    providerErrors,
    textType,
    toolType,
    toolMethod,
    unknownFieldCount,
  };
}

export class PiAiResponseError extends Error {
  readonly diagnostics: ReturnType<typeof piAiOutputDiagnostics>;

  constructor(message: string, output: string) {
    super(message);
    this.name = "PiAiResponseError";
    this.diagnostics = piAiOutputDiagnostics(output);
  }
}
