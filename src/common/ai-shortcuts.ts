export interface AiShortcut {
  id: string;
  label: string;
  command: string;
  prompt: string;
}

export const DEFAULT_AI_SHORTCUTS: AiShortcut[] = [
  {
    id: "cluster-health",
    label: "Cluster health",
    command: "health",
    prompt:
      "Act as an experienced DevOps engineer and SRE. Inspect the current cluster health using read-only queries. Briefly summarize the main events, anomalies and their timeline. Prioritize findings by impact on availability and latency, distinguish facts from hypotheses, and suggest focused diagnostic checks with the evidence each would establish. State missing evidence and never change resources.",
  },
  {
    id: "pod-issues",
    label: "Pod issues",
    command: "pods",
    prompt:
      "Act as an experienced DevOps engineer and SRE. Use read-only queries to find unhealthy or restarting pods in the current cluster. Check crashes, OOM events, probe failures, process termination, timeouts and dependency failures. Correlate relevant events, distinguish primary failures from downstream symptoms and facts from hypotheses, and request focused read-only evidence when needed. Prioritize useful next checks without changing resources.",
  },
  {
    id: "log-counters",
    label: "Log counters",
    command: "logs",
    prompt:
      "Act as an experienced DevOps engineer and SRE. Use available read-only log counters to summarize errors and warnings for the current context, grouping repeated categories where the data supports it. Explain the time range, severity, trends and limits of the available evidence. Distinguish facts from hypotheses, never infer raw log messages from counters, and suggest prioritized read-only checks to clarify impact and possible dependency failures. Do not change resources.",
  },
];

export function normalizeAiShortcutCommand(command: string): string {
  return command.trim().replace(/^\//, "").toLowerCase();
}

export function sanitizeAiShortcuts(value: unknown): AiShortcut[] {
  if (!Array.isArray(value)) return [];
  const result: AiShortcut[] = [];
  const ids = new Set<string>();
  const commands = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, command, prompt } = entry;
    if ([id, label, command, prompt].some((field) => typeof field !== "string")) continue;
    const normalizedCommand = normalizeAiShortcutCommand(command);
    if (
      !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedCommand) ||
      !id.trim() ||
      id.length > 128 ||
      !label.trim() ||
      label.trim().length > 80 ||
      !prompt.trim() ||
      prompt.length > 10000 ||
      ids.has(id) ||
      commands.has(normalizedCommand)
    )
      continue;
    ids.add(id);
    commands.add(normalizedCommand);
    result.push({ id, label: label.trim(), command: normalizedCommand, prompt: prompt.trim() });
  }
  return result;
}

export function expandAiShortcut(text: string, shortcuts: readonly AiShortcut[]): string {
  const match = /^\/([a-z0-9][a-z0-9_-]{0,31})(?:\s+|$)/i.exec(text);
  if (!match) return text;
  const shortcut = shortcuts.find((entry) => entry.command === match[1].toLowerCase());
  if (!shortcut) return text;
  const rest = text.slice(match[0].length).trim();
  return rest ? `${shortcut.prompt}\n\n${rest}` : shortcut.prompt;
}

const LEGACY_SHORTCUT_PROMPTS: Record<string, string> = {
  "cluster-health":
    "Inspect the current cluster health using read-only queries. Summarize warnings and suggest useful next checks without changing resources.",
  "pod-issues":
    "Use read-only queries to find unhealthy or restarting pods in the current cluster. Explain likely causes and relevant events without changing resources.",
  "log-counters":
    "Use available read-only log data to summarize error and warning counts for the current context. Explain the time range and any limits of the available data without changing resources.",
};

export function upgradeDefaultAiShortcuts(shortcuts: AiShortcut[]): AiShortcut[] {
  return shortcuts.map((entry) => {
    const updated = DEFAULT_AI_SHORTCUTS.find((candidate) => candidate.id === entry.id);
    return updated &&
      entry.label === updated.label &&
      entry.command === updated.command &&
      entry.prompt === LEGACY_SHORTCUT_PROMPTS[entry.id]
      ? { ...updated }
      : entry;
  });
}
