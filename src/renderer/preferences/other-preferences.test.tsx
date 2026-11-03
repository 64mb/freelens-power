// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  power: { nodeBulkActions: true },
  monitoring: { resourceSearchEnabled: true, relationshipsVisible: true },
}));
vi.mock("../../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => stores.power },
}));
vi.mock("../../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => stores.monitoring },
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
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
    },
  },
}));

import { OtherPreferences } from "./other-preferences";

afterEach(cleanup);

it("uses one switch for Node actions and Pod customization", () => {
  render(<OtherPreferences />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Bulk resource actions" }));
  expect(stores.power.nodeBulkActions).toBe(false);
  expect(screen.getByText("Bulk actions and clearer resource dialogs.")).toBeTruthy();
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
});

it("uses the existing resource search setting with an ASCII shortcut label", () => {
  render(<OtherPreferences />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable resource search (Shift-Shift)" }));
  expect(stores.monitoring.resourceSearchEnabled).toBe(false);
  expect(stores.monitoring.relationshipsVisible).toBe(true);
  expect(screen.getByText(/Turning this off stops keyboard search and background indexing/)).toBeTruthy();
});
