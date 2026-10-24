import { useEffect, useState } from "react";

export const POWER_LOGS_SQL_DRAFT_PROMPT = `On the Power Logs workspace, help draft SQLite SELECT queries for captured logs.
The table is logs(timestamp INTEGER, pod TEXT, podUid TEXT, container TEXT, level TEXT, message TEXT, fieldsJson TEXT, previous INTEGER).
Timestamp is Unix epoch milliseconds and can be NULL. previous is 0 or 1. fieldsJson contains JSON text or NULL, usable with SQLite json_extract.
Return proposed queries in fenced sql blocks. Draft queries only: never execute them, call a query tool, or claim they ran. The user can insert a draft into the SQL editor, review it, and explicitly run it.`;

export function isPowerLogsWorkspace(): boolean {
  return (
    !!document.querySelector('[data-testid="power-logs-page"]') || /\/power-logs\/?$/.test(window.location.pathname)
  );
}

export function usePowerLogsWorkspace(): boolean {
  const [active, setActive] = useState(isPowerLogsWorkspace);
  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent<{ active?: unknown }>).detail?.active;
      if (typeof value === "boolean") setActive(value);
    };
    window.addEventListener("power-logs-workspace-change", update);
    return () => window.removeEventListener("power-logs-workspace-change", update);
  }, []);
  return active;
}
