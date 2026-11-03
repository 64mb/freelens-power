import type { WebContents } from "electron";

import type { DashboardAiAccess } from "../common/dashboard-ai";

let reader: ((sender: WebContents) => DashboardAiAccess | undefined) | undefined;

export function setDashboardAiReader(value: typeof reader): void {
  reader = value;
}

export function getDashboardAiAccess(sender: WebContents): DashboardAiAccess | undefined {
  return reader?.(sender);
}

export async function waitForDashboardAiRead<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new Error("AI request canceled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        timeout = setTimeout(() => reject(new Error("Dashboard widget read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
