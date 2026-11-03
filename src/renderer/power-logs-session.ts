import { type Dispatch, type SetStateAction, useState } from "react";

interface WorkspaceSession {
  values: Map<string, unknown>;
  restored: boolean;
}

const sessions = new Map<string, WorkspaceSession>();
const maximumSessions = 3;

export function clearPowerLogsSessions(): void {
  sessions.clear();
}

export function powerLogsSession(key: string, targetUid?: string, requestedSource?: string): WorkspaceSession {
  let session = sessions.get(key);
  const previousTarget = session?.values.get("target") as { uid: string } | undefined;
  if (targetUid && (targetUid !== previousTarget?.uid || requestedSource !== session?.values.get("source")))
    session = undefined;
  if (!session) session = { values: new Map(), restored: false };
  else session.restored = true;
  sessions.delete(key);
  sessions.set(key, session);
  while (sessions.size > maximumSessions) sessions.delete(sessions.keys().next().value!);
  return session;
}

export function usePowerLogsSessionState<S>(
  session: WorkspaceSession,
  key: string,
  initial: S | (() => S),
): [S, Dispatch<SetStateAction<S>>];
export function usePowerLogsSessionState<S = undefined>(
  session: WorkspaceSession,
  key: string,
): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
export function usePowerLogsSessionState<S>(session: WorkspaceSession, key: string, initial?: S | (() => S)) {
  const state = useState<S | undefined>(() => {
    if (session.values.has(key)) return session.values.get(key) as S;
    return typeof initial === "function" ? (initial as () => S)() : initial;
  });
  session.values.set(key, state[0]);
  return state;
}
