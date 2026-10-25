// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IncidentCopyButton } from "./incident-copy-button";
import { MockTooltip } from "./native-tooltip.test-utils";

const mocks = vi.hoisted(() => ({ write: vi.fn(), clusterId: "cluster-a", clusterName: "Sample cluster" }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: { Tooltip: (props: any) => <MockTooltip {...props} /> },
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: mocks.clusterId, name: mocks.clusterName } }) } },
  },
}));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.write } }));
afterEach(() => {
  cleanup();
  mocks.write.mockReset();
});
it("copies once with visible success feedback", () => {
  const view = render(<IncidentCopyButton incident={{ problem: "Pending pod", facts: ["Insufficient cpu"] }} />);
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.write.mock.calls[0][0]).toContain("Insufficient cpu");
  expect(view.getByRole("status").textContent).toBe("Copied");
});
it("shows truthful clipboard failure without claiming success", () => {
  mocks.write.mockImplementation(() => {
    throw new Error("unavailable");
  });
  const view = render(<IncidentCopyButton incident={{ problem: "Pending pod", facts: [] }} />);
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  expect(view.getByRole("status").textContent).toBe("Unable to copy incident summary");
  expect(view.queryByText("Copied")).toBeNull();
});

it("uses the current matching cluster display name at copy time", () => {
  const view = render(<IncidentCopyButton clusterId="cluster-a" incident={{ problem: "Pending", facts: [] }} />);
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  expect(mocks.write.mock.calls[0][0]).toContain("Cluster: Sample cluster");
});
it("blocks stale cluster evidence before touching the clipboard", () => {
  const view = render(<IncidentCopyButton clusterId="cluster-b" incident={{ problem: "Pending", facts: [] }} />);
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  expect(mocks.write).not.toHaveBeenCalled();
  expect(view.getByRole("status").textContent).toContain("Cluster changed");
});
