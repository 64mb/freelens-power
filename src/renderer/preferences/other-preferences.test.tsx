// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => ({
  power: { nodeBulkActions: true, podBulkActions: true },
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

it("controls node and Pod bulk actions independently", () => {
  render(<OtherPreferences />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Bulk node actions" }));
  expect(stores.power.nodeBulkActions).toBe(false);
  expect(stores.power.podBulkActions).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Customize Pod bulk actions" }));
  expect(stores.power.podBulkActions).toBe(false);
});

it("uses the existing resource search setting with an ASCII shortcut label", () => {
  render(<OtherPreferences />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable resource search (Shift-Shift)" }));
  expect(stores.monitoring.resourceSearchEnabled).toBe(false);
  expect(stores.monitoring.relationshipsVisible).toBe(true);
  expect(screen.getByText(/Turning this off stops keyboard search and background indexing/)).toBeTruthy();
});
