import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { AI_MODELS_CHANNEL, type AiModel } from "../common/ai-models";

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function parseAiModels(value: unknown): AiModel[] {
  if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) return [];
  const result: AiModel[] = [];
  const seen = new Set<string>();
  for (const item of value.models.slice(0, 200)) {
    if (!item || typeof item !== "object" || typeof item.slug !== "string" || !identifier.test(item.slug)) continue;
    if (item.visibility !== "list" || seen.has(item.slug)) continue;
    const levels: string[] = Array.isArray(item.supported_reasoning_levels)
      ? [
          ...new Set<string>(
            item.supported_reasoning_levels
              .filter((level: unknown): level is { effort: string } =>
                Boolean(
                  level &&
                    typeof level === "object" &&
                    "effort" in level &&
                    typeof level.effort === "string" &&
                    efforts.has(level.effort),
                ),
              )
              .map((level: { effort: string }) => level.effort),
          ),
        ]
      : [];
    const label =
      typeof item.display_name === "string" && /^[\w .()+-]{1,100}$/.test(item.display_name)
        ? item.display_name
        : item.slug;
    result.push({
      id: item.slug,
      label,
      reasoningEfforts: levels,
      defaultReasoningEffort: levels.includes(item.default_reasoning_level) ? item.default_reasoning_level : "",
    });
    seen.add(item.slug);
  }
  return result;
}

export async function readAiModels(
  directory = process.env.CODEX_HOME || join(homedir(), ".codex"),
): Promise<AiModel[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(directory, "models_cache.json"), "r");
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES) return [];
    const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CACHE_BYTES) return [];
    return parseAiModels(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

export function startAiModels(): () => void {
  ipcMain.handle(AI_MODELS_CHANNEL, async (event, provider: unknown = "codex") => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return [];
    try {
      const url = new URL(event.senderFrame?.url ?? "");
      if (
        url.protocol !== "https:" ||
        !(url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
      )
        return [];
      if (provider === "claude")
        return ["sonnet", "opus", "haiku"].map((id) => ({
          id,
          label: id[0].toUpperCase() + id.slice(1),
          reasoningEfforts: [],
          defaultReasoningEffort: "",
        }));
      if (provider !== "codex") return [];
      return readAiModels();
    } catch {
      return [];
    }
  });
  return () => ipcMain.removeHandler(AI_MODELS_CHANNEL);
}
