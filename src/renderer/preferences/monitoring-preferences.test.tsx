// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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

it("keeps resource search outside Monitoring settings", async () => {
  render(<MonitoringPreferences />);
  expect(screen.queryByRole("checkbox", { name: /resource search/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Show Relationships in sidebar" })).toBeTruthy();
});
