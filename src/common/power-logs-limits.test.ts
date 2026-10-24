import { afterEach, expect, it } from "vitest";
import { POWER_LOGS_DEFAULT_LIMITS, POWER_LOGS_LIMITS } from "./power-logs";
import { applyPowerLogsLimits, LOG_LIMIT_FIELDS, normalizePowerLogsLimits } from "./power-logs-limits";

afterEach(() => {
  applyPowerLogsLimits(undefined);
});

it("describes every limit exactly once and preserves all defaults", () => {
  expect(LOG_LIMIT_FIELDS.map((field) => field.key).sort()).toEqual(Object.keys(POWER_LOGS_DEFAULT_LIMITS).sort());
  expect(normalizePowerLogsLimits(undefined)).toEqual(POWER_LOGS_DEFAULT_LIMITS);
  expect(normalizePowerLogsLimits(null)).toEqual(POWER_LOGS_DEFAULT_LIMITS);
  for (const field of LOG_LIMIT_FIELDS) {
    expect(POWER_LOGS_DEFAULT_LIMITS[field.key]).toBeGreaterThanOrEqual(field.min);
    expect(POWER_LOGS_DEFAULT_LIMITS[field.key]).toBeLessThanOrEqual(field.max);
  }
});

it("uses defaults for invalid data and clamps finite values to integer bounds", () => {
  expect(normalizePowerLogsLimits({ liveRows: NaN, liveBytes: Infinity, batchRows: "42", captures: null })).toEqual(
    POWER_LOGS_DEFAULT_LIMITS,
  );
  const limits = normalizePowerLogsLimits({ liveRows: -100, sources: 1e12, captures: 4.9 });
  expect(limits.liveRows).toBe(1);
  expect(limits.sources).toBe(2000);
  expect(limits.captures).toBe(4);
});

it("keeps batch and capture source budgets large enough for a record", () => {
  const limits = normalizePowerLogsLimits({
    recordBytes: 16 * 1024 * 1024,
    batchBytes: 1024,
    captureSourceBytes: 1024,
  });
  expect(limits.batchBytes).toBe(limits.recordBytes + 3);
  expect(limits.captureSourceBytes).toBe(limits.recordBytes);
  const record = { message: "x".repeat(limits.recordBytes - JSON.stringify({ message: "" }).length) };
  expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBe(limits.recordBytes);
  expect(new TextEncoder().encode(JSON.stringify([record])).byteLength).toBeLessThanOrEqual(limits.batchBytes);
});

it("updates the shared runtime object in place and resets omitted values to defaults", () => {
  const reference = POWER_LOGS_LIMITS;
  const applied = applyPowerLogsLimits({ liveRows: 123, requestsPerSecond: 5 });
  expect(POWER_LOGS_LIMITS).toBe(reference);
  expect(POWER_LOGS_LIMITS).toEqual(applied);
  expect(POWER_LOGS_LIMITS.liveRows).toBe(123);
  expect(normalizePowerLogsLimits({})).toEqual(POWER_LOGS_DEFAULT_LIMITS);
  applyPowerLogsLimits({});
  expect(POWER_LOGS_LIMITS).toEqual(POWER_LOGS_DEFAULT_LIMITS);
});
