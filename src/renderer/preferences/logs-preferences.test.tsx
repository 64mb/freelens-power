// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ButtonHTMLAttributes, ReactNode } from "react";

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
      Select: ({
        options,
        value,
        onChange,
        isSearchable: _isSearchable,
        isClearable: _isClearable,
        ...props
      }: {
        options: { value: string; label: string }[];
        value: string;
        onChange(option: { value: string } | null): void;
        isSearchable: boolean;
        isClearable: boolean;
      }) => (
        <select {...props} value={value} onChange={(event) => onChange({ value: event.target.value })}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
import { applyPowerLogsLimits } from "../../common/power-logs-limits";
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

it("renders five native selects with the default presets and no number inputs", () => {
  render(<LogsPreferences />);
  expect(screen.getAllByRole("combobox")).toHaveLength(5);
  expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
  for (const [name, value] of [
    ["Live buffer", "2"],
    ["History per container", "1"],
    ["Capture size", "2"],
    ["Saved captures", "1"],
    ["Retention", "1"],
  ]) {
    expect((screen.getByRole("combobox", { name }) as HTMLSelectElement).value).toBe(value);
  }
  expect(preferences.toJSON().limits).toEqual(POWER_LOGS_DEFAULT_LIMITS);
});

it("preserves custom values and hidden limits when opening settings", () => {
  preferences.fromStore({
    limits: {
      ...POWER_LOGS_DEFAULT_LIMITS,
      liveRows: 321,
      liveBytes: 1234567,
      historyBytes: 234567,
      captureBytes: 12345678,
      captures: 7,
      ttlMs: 123000,
      batchRows: 42,
      resultRows: 23,
    },
  });
  applyPowerLogsLimits(preferences.limits);
  const previous = preferences.toJSON().limits;
  render(<LogsPreferences />);
  expect(preferences.toJSON().limits).toEqual(previous);
  expect(POWER_LOGS_LIMITS).toEqual(previous);
  for (const select of screen.getAllByRole("combobox") as HTMLSelectElement[]) {
    expect(select.value).toBe("custom");
    expect(select.selectedOptions[0].textContent).toMatch(/^Custom:/);
  }
  expect(screen.getByRole("option", { name: /^Custom: 1,000 lines \/ / })).toBeTruthy();
});

it.each([
  ["Live buffer", "1", { liveRows: 5000, liveBytes: 8 * 1024 * 1024 }],
  ["History per container", "0", { historyLines: 500, historyBytes: 512 * 1024 }],
  ["Capture size", "3", { captureBytes: 512 * 1024 * 1024 }],
  ["Saved captures", "3", { captures: 10 }],
  ["Retention", "4", { ttlMs: 3 * 24 * 60 * 60 * 1000 }],
])("changes only the selected %s preset keys", (name, value, patch) => {
  preferences.fromStore({
    limits: { ...POWER_LOGS_DEFAULT_LIMITS, liveRows: 321, historyBytes: 234567, batchRows: 42, resultRows: 23 },
  });
  const previous = preferences.toJSON().limits;
  render(<LogsPreferences />);
  fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  expect(preferences.toJSON().limits).toEqual({ ...previous, ...patch });
  expect(POWER_LOGS_LIMITS).toEqual({ ...previous, ...patch });
});

it("resets all limits only when explicitly requested", () => {
  preferences.fromStore({
    enabled: true,
    gentle: false,
    compactRows: true,
    limits: { liveRows: 321, liveBytes: 1024 * 1024, resultRows: 23 },
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
  expect((screen.getByRole("combobox", { name: "Live buffer" }) as HTMLSelectElement).value).toBe("2");
});
