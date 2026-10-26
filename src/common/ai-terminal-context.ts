import { redactKubernetesJsonText, redactKubernetesYamlText } from "./ai-resource-payload";

export const AI_TERMINAL_MAX_ROWS = 300;
export const AI_TERMINAL_MAX_BYTES = 32 * 1024;
const MAX_SOURCE_CHARACTERS = 1_000_000;

export interface AiTerminalSnapshot {
  text: string;
  capturedAt: string;
  truncated: boolean;
}

export function redactAiTerminalText(text: string): string {
  const clean = text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  try {
    return redactKubernetesJsonText(clean);
  } catch {
    /* terminal prose may contain YAML documents */
  }
  let allJsonLines = true;
  const independent = clean.split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      return redactKubernetesJsonText(line);
    } catch {
      allJsonLines = false;
      return line;
    }
  });
  if (allJsonLines) return independent.join("\n");
  const yamlSafe = redactKubernetesYamlText(clean);
  if (yamlSafe !== clean) return yamlSafe;
  let marker: string | undefined;
  const getMarker = () => {
    if (marker !== undefined) return marker;
    const used = new Set(Array.from(clean.matchAll(/# __ai_json_line_(\d+)_/g), (match) => match[1]));
    let index = 0;
    while (used.has(String(index))) index++;
    marker = `# __ai_json_line_${index}_`;
    return marker;
  };
  const jsonLines: string[] = [];
  const yaml = clean
    .split("\n")
    .map((line) => {
      if (!/^[\[{]/.test(line)) return line;
      try {
        const safe = redactKubernetesJsonText(line);
        const index = jsonLines.push(safe) - 1;
        return getMarker() + index;
      } catch {
        return line;
      }
    })
    .join("\n");
  if (jsonLines.length)
    return redactKubernetesYamlText(yaml)
      .split("\n")
      .map((line) =>
        marker !== undefined && line.startsWith(marker) ? (jsonLines[Number(line.slice(marker.length))] ?? line) : line,
      )
      .join("\n");
  return redactKubernetesYamlText(clean);
}

export function sanitizeAiTerminalSnapshot(value: unknown): AiTerminalSnapshot | undefined {
  if (!value || typeof value !== "object") return;
  const input = value as Record<string, unknown>;
  if (
    typeof input.text !== "string" ||
    input.text.length > MAX_SOURCE_CHARACTERS ||
    typeof input.capturedAt !== "string" ||
    input.capturedAt.length > 40 ||
    !Number.isFinite(Date.parse(input.capturedAt))
  )
    return;
  // redact resource payloads before selecting the terminal tail
  const safe = redactAiTerminalText(input.text.replace(/\r\n?/g, "\n"));
  const lines = safe.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && tail.length < AI_TERMINAL_MAX_ROWS; index--) {
    const line = lines[index];
    const size = new TextEncoder().encode(line).length + (tail.length ? 1 : 0);
    if (bytes + size > AI_TERMINAL_MAX_BYTES) break;
    bytes += size;
    tail.unshift(line);
  }
  if (!tail.length || !tail.some((line) => line.trim())) return;
  return {
    text: tail.join("\n"),
    capturedAt: new Date(input.capturedAt).toISOString(),
    truncated: input.truncated === true || tail.length < lines.length,
  };
}
