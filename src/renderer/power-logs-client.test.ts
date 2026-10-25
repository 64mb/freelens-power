import { afterEach, expect, it, vi } from "vitest";
import { POWER_LOGS_CHANNEL } from "../common/power-logs";
import { createPowerLogsClient } from "./power-logs-client";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
afterEach(() => mocks.invoke.mockReset());

it("saves an exact per-capture SQL draft in its partition and returns updated capture metadata", async () => {
  const partition = { clusterId: "cluster-example", contextId: "context-example" };
  const sql = "SELECT '\n -- unfinished draft";
  const updated = { id: "capture-example", lastSql: sql };
  mocks.invoke.mockResolvedValue(updated);
  const client = createPowerLogsClient(partition);
  await expect(client.saveSql("capture-example", sql)).resolves.toBe(updated);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(POWER_LOGS_CHANNEL, {
    ...partition,
    operation: "save-sql",
    captureId: "capture-example",
    sql,
  });
  await client.saveSql("capture-example", "");
  expect(mocks.invoke).toHaveBeenLastCalledWith(POWER_LOGS_CHANNEL, {
    ...partition,
    operation: "save-sql",
    captureId: "capture-example",
    sql: "",
  });
});

it("propagates unavailable-capture failures without claiming a saved draft", async () => {
  mocks.invoke.mockRejectedValue(new Error("Capture unavailable"));
  await expect(
    createPowerLogsClient({ clusterId: "cluster-example", contextId: "context-example" }).saveSql(
      "missing",
      "SELECT 1",
    ),
  ).rejects.toThrow("unavailable");
});
