// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ButtonHTMLAttributes, ReactNode } from "react";

const storage = vi.hoisted(() => ({ status: vi.fn(), clear: vi.fn(), confirm: vi.fn() }));
vi.mock("../power-logs-storage", () => ({ powerLogsStorage: storage }));
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
      ConfirmDialog: { open: storage.confirm },
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
  vi.clearAllMocks();
  storage.status.mockResolvedValue({
    bytes: 2 * 1024 * 1024,
    maxBytes: 1024 * 1024 * 1024,
    captures: 3,
    collecting: 1,
  });
  storage.clear.mockResolvedValue(true);
  storage.confirm.mockReset();
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

it("shows physical storage and confirms clearing completed captures across all clusters without changing limits", async () => {
  preferences.fromStore({ enabled: true, limits: { liveRows: 321 } });
  const previous = preferences.toJSON();
  render(<LogsPreferences />);
  await screen.findByText("2.00 / 1024 MiB");
  expect(screen.queryByRole("button", { name: "Reset log limits" })).toBeNull();
  expect(screen.getByRole("progressbar", { name: "Local log storage" }).getAttribute("aria-valuemax")).toBe(
    String(1024 * 1024 * 1024),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(storage.clear).not.toHaveBeenCalled();
  const confirmation = storage.confirm.mock.calls[0][0];
  expect(confirmation.message).toMatch(/pinned snapshots.*all clusters/);
  expect(confirmation.message).toMatch(/Active captures are preserved/);
  storage.status.mockResolvedValue({ bytes: 0, maxBytes: 1024 * 1024 * 1024, captures: 1, collecting: 1 });
  confirmation.ok();
  await screen.findByText("0.00 / 1024 MiB");
  expect(storage.clear).toHaveBeenCalledOnce();
  expect(preferences.toJSON()).toEqual(previous);
});

it("keeps settings and usage visible when clearing fails", async () => {
  preferences.enabled = true;
  storage.clear.mockRejectedValueOnce(new Error("unavailable"));
  render(<LogsPreferences />);
  await screen.findByText("2.00 / 1024 MiB");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  storage.confirm.mock.calls[0][0].ok();
  await screen.findByText("Unable to clear log storage. Try again.");
  expect(screen.getByText("2.00 / 1024 MiB")).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(false),
  );
});
