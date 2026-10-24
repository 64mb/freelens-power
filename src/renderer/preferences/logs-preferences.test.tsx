// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

const singleton = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock("@freelensapp/extensions", () => ({
  Common: {
    Store: {
      ExtensionStore: class {
        static getInstanceOrCreate() {
          return singleton.store;
        }
      },
    },
  },
  Renderer: {
    Component: {
      Input: ({
        onChange,
        onSubmit,
        ...props
      }: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "onSubmit"> & {
        onChange(value: string): void;
        onSubmit(): void;
      }) => (
        <input
          {...props}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
          }}
        />
      ),
      Switch: ({
        checked,
        onChange,
        children,
      }: {
        checked: boolean;
        onChange(value: boolean): void;
        children: ReactNode;
      }) => (
        <label>
          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          {children}
        </label>
      ),
      Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
      Icon: () => null,
    },
  },
}));

import { POWER_LOGS_DEFAULT_LIMITS, POWER_LOGS_LIMITS } from "../../common/power-logs";
import { applyPowerLogsLimits, LOG_LIMIT_FIELDS } from "../../common/power-logs-limits";
import { LogsPreferencesStore } from "../../common/store/logs-preferences-store";
import { LogsPreferences } from "./logs-preferences";

let preferences: LogsPreferencesStore;
beforeEach(() => {
  preferences = new LogsPreferencesStore();
  singleton.store = preferences;
  applyPowerLogsLimits(undefined);
});
afterEach(() => {
  cleanup();
  applyPowerLogsLimits(undefined);
});

it("renders every limit and commits a clamped draft only on blur", () => {
  render(<LogsPreferences />);
  expect(screen.getAllByRole("spinbutton")).toHaveLength(LOG_LIMIT_FIELDS.length);
  const input = screen.getByRole("spinbutton", { name: "Live logs: Buffered rows" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "-5" } });
  expect(preferences.limits.liveRows).toBe(POWER_LOGS_DEFAULT_LIMITS.liveRows);
  expect(POWER_LOGS_LIMITS.liveRows).toBe(POWER_LOGS_DEFAULT_LIMITS.liveRows);
  fireEvent.blur(input);
  expect(input.value).toBe("1");
  expect(preferences.toJSON().limits.liveRows).toBe(1);
  expect(POWER_LOGS_LIMITS.liveRows).toBe(1);
});

it("converts displayed units and commits on Enter", () => {
  render(<LogsPreferences />);
  const input = screen.getByRole("spinbutton", { name: "Live logs: Buffer size" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "12.5" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(preferences.toJSON().limits.liveBytes).toBe(12.5 * 1024 * 1024);
  expect(POWER_LOGS_LIMITS.liveBytes).toBe(12.5 * 1024 * 1024);
});

it("restores the previous value when a draft is empty or invalid", () => {
  preferences.fromStore({ limits: { liveRows: 321 } });
  applyPowerLogsLimits(preferences.limits);
  render(<LogsPreferences />);
  const input = screen.getByRole("spinbutton", { name: "Live logs: Buffered rows" }) as HTMLInputElement;
  for (const value of ["", "NaN"]) {
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(input.value).toBe("321");
    expect(preferences.toJSON().limits.liveRows).toBe(321);
    expect(POWER_LOGS_LIMITS.liveRows).toBe(321);
  }
});

it("resets persisted limits, runtime limits and rendered values together", () => {
  preferences.fromStore({
    enabled: true,
    gentle: false,
    compactRows: true,
    limits: { liveRows: 321, liveBytes: 1024 * 1024 },
  });
  applyPowerLogsLimits(preferences.limits);
  render(<LogsPreferences />);
  fireEvent.click(screen.getByRole("button", { name: "Reset log limits" }));
  expect(preferences.toJSON()).toMatchObject({
    enabled: true,
    gentle: false,
    compactRows: true,
    limits: POWER_LOGS_DEFAULT_LIMITS,
  });
  expect(POWER_LOGS_LIMITS).toEqual(POWER_LOGS_DEFAULT_LIMITS);
  expect((screen.getByRole("spinbutton", { name: "Live logs: Buffered rows" }) as HTMLInputElement).value).toBe(
    "10000",
  );
  expect((screen.getByRole("spinbutton", { name: "Live logs: Buffer size" }) as HTMLInputElement).value).toBe("16");
});
