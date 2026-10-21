// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { formatDateTime } from "./date-time";

describe("formatDateTime", () => {
  it("formats Date, epoch and ISO values using local date parts and two spaces", () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    for (const value of [date, date.getTime(), date.toISOString()]) {
      expect(formatDateTime(value)).toBe("02.01.2026  03:04:05");
    }
  });

  it("uses a 24-hour clock including midnight and the end of the day", () => {
    expect(formatDateTime(new Date(2026, 11, 31, 0, 0, 0))).toBe("31.12.2026  00:00:00");
    expect(formatDateTime(new Date(2026, 11, 31, 23, 59, 59))).toBe("31.12.2026  23:59:59");
  });

  it("handles invalid timestamps", () => {
    for (const value of ["invalid", "", NaN, Infinity, new Date(NaN)]) {
      expect(formatDateTime(value)).toBe("Unavailable");
    }
  });
});
