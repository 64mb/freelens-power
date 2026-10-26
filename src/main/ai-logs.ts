import { redactAiTerminalText } from "../common/ai-terminal-context";
import { type AiReadRequest, aiReadQuery } from "./ai-resources";

export interface AiLogQuery {
  path: string;
  query: { tailLines: 100; limitBytes: 65536; follow: false; timestamps: false };
}

export function aiLogQuery(request: AiReadRequest): AiLogQuery {
  if (request.method !== "logs") throw new Error("Unsupported log method");
  const resource = aiReadQuery({ method: "pods", name: request.name, namespace: request.namespace });
  if (!resource.name || !resource.namespace) throw new Error("Select a pod and namespace to inspect logs");
  return {
    path: `/api/v1/namespaces/${resource.namespace}/pods/${resource.name}/log`,
    query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
  };
}

// redact recognized Kubernetes payloads before bounding the forwarded log sample
export function summarizeAiLogs(input: unknown) {
  if (typeof input !== "string") throw new Error("Log response is unavailable");
  const bounded = Buffer.from(redactAiTerminalText(input), "utf8").subarray(0, 65536).toString("utf8");
  const lines = bounded
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-100);
  const patterns = {
    errorLines: /\b(?:error|fatal|panic|exception)\b/i,
    warningLines: /\b(?:warn|warning)\b/i,
    timeoutLines: /\b(?:timeout|timed out|deadline exceeded)\b/i,
    outOfMemoryLines: /\b(?:oomkilled|out of memory|cannot allocate memory)\b/i,
    connectionFailureLines: /\b(?:connection refused|connection reset|no route to host|network unreachable)\b/i,
    permissionFailureLines: /\b(?:permission denied|forbidden|unauthorized)\b/i,
  };
  const counts: Record<keyof typeof patterns, number> = {
    errorLines: 0,
    warningLines: 0,
    timeoutLines: 0,
    outOfMemoryLines: 0,
    connectionFailureLines: 0,
    permissionFailureLines: 0,
  };
  for (const line of lines) {
    for (const key of Object.keys(patterns) as (keyof typeof patterns)[]) {
      if (patterns[key].test(line)) counts[key]++;
    }
  }
  return { lines, sampledNonemptyLines: lines.length, ...counts, boundedSample: true };
}
