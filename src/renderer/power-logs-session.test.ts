import { beforeEach, expect, it } from "vitest";
import { clearPowerLogsSessions, powerLogsSession } from "./power-logs-session";

beforeEach(clearPowerLogsSessions);

it("retains at most three recently opened cluster/context workspaces", () => {
  const first = powerLogsSession("cluster-a:context-a");
  first.values.set("text", "first filter");
  powerLogsSession("cluster-b:context-b");
  powerLogsSession("cluster-c:context-c");
  expect(powerLogsSession("cluster-a:context-a")).toBe(first);
  powerLogsSession("cluster-d:context-d");
  expect(powerLogsSession("cluster-b:context-b").restored).toBe(false);
  expect(powerLogsSession("cluster-a:context-a").values.get("text")).toBe("first filter");
});

it("isolates contexts and discards a snapshot for a different explicit resource", () => {
  const first = powerLogsSession("cluster-a:context-a", "pod-a");
  first.values.set("target", { uid: "pod-a" });
  first.values.set("text", "first filter");
  expect(powerLogsSession("cluster-a:context-b").values.size).toBe(0);
  expect(powerLogsSession("cluster-a:context-a", "pod-a")).toBe(first);
  expect(powerLogsSession("cluster-a:context-a", "pod-b").values.size).toBe(0);
});

it("drops all session references on feature disposal", () => {
  powerLogsSession("cluster-a:context-a").values.set("text", "first filter");
  clearPowerLogsSessions();
  const fresh = powerLogsSession("cluster-a:context-a");
  expect(fresh.values.size).toBe(0);
  expect(fresh.restored).toBe(false);
});
