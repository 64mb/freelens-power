import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AiModel, piModelEfforts, piModelLabel } from "../common/ai-models";
import { preparePiAiEnvironment } from "./ai-pi";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function parsePiAiModels(output: string): AiModel[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return [];
  const models: AiModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length !== 6) continue;
    const [provider, model, context, maxOut, thinking, images] = columns;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(provider) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/+-]{0,250}$/.test(model) ||
      !/^\d+(?:\.\d+)?[KM]?$/.test(context) ||
      !/^\d+(?:\.\d+)?[KM]?$/.test(maxOut) ||
      !["yes", "no"].includes(thinking) ||
      !["yes", "no"].includes(images)
    )
      continue;
    const id = `${provider}/${model}`;
    const label = piModelLabel(id);
    if (!label) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    models.push({
      id,
      label,
      reasoningEfforts: thinking === "yes" ? piModelEfforts(id) : [],
      defaultReasoningEffort: "",
    });
    if (models.length === 1000) break;
  }
  return models;
}

export async function readPiAiModels(source: NodeJS.ProcessEnv = process.env): Promise<AiModel[]> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "freelens-pi-models-"));
    const environment = await preparePiAiEnvironment(directory, source);
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "pi",
        [
          "--list-models",
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
        ],
        {
          cwd: directory,
          env: environment,
          shell: false,
          timeout: 20_000,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    return parsePiAiModels(output);
  } catch {
    return [];
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
