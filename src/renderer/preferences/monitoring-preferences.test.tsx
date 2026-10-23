// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({
  diagnosticsVisible: true,
  relationshipsVisible: true,
  resourceSearchEnabled: true,
  enabled: false,
  historyEnabled: false,
}));
vi.mock("../../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => preferences },
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("../monitoring-history", () => ({
  monitoringHistory: { status: async () => ({ available: true, bytes: 0, samples: 0 }), clear: vi.fn() },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Switch: ({
        checked,
        onChange,
        children,
      }: {
        checked: boolean;
        onChange(value: boolean): void;
        children: unknown;
      }) => (
        <label>
          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          {children}
        </label>
      ),
      Button: (props: object) => <button type="button" {...props} />,
      Icon: () => null,
    },
  },
}));

import { MonitoringPreferences } from "./monitoring-preferences";

it("uses the native switch to disable the full search feature independently of Relationships", async () => {
  render(<MonitoringPreferences />);
  const toggle = screen.getByRole("checkbox", { name: "Enable resource search (Shift–Shift)" });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  fireEvent.click(toggle);
  expect(preferences.resourceSearchEnabled).toBe(false);
  expect(preferences.relationshipsVisible).toBe(true);
  expect(screen.getByText(/Turning this off stops keyboard search and background indexing/)).toBeTruthy();
});
