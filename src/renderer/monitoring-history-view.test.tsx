// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Select: () => {
        throw new Error("Missing host injection context");
      },
    },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => ({ historyEnabled: false }) },
}));
vi.mock("./monitoring-history", () => ({ monitoringHistory: {} }));

import { MonitoringHistoryRange } from "./monitoring-history-view";

it("lets detached chart roots select historical ranges without host injection context", () => {
  const change = vi.fn();
  const view = render(<MonitoringHistoryRange range="30m" onChange={change} />);
  fireEvent.change(view.getByLabelText("History range"), { target: { value: "24h" } });
  expect(change).toHaveBeenCalledWith("24h");
  view.unmount();
});
