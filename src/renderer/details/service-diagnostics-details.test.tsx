// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { PropsWithChildren } from "react";

const state = vi.hoisted(() => ({ pods: vi.fn(), slices: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      DrawerTitle: ({ children }: PropsWithChildren<{}>) => <h2>{children}</h2>,
      DrawerItem: ({ children, name }: PropsWithChildren<{ name: string }>) => (
        <div>
          {name}: {children}
        </div>
      ),
      Icon: () => null,
    },
    K8sApi: { podsApi: { list: state.pods }, endpointSliceApi: { list: state.slices } },
  },
}));

import { HpaDiagnosticsDetails } from "./hpa-diagnostics-details";
import { ServiceDiagnosticsDetails } from "./service-diagnostics-details";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("retains EndpointSlice evidence when pod access is denied and refreshes on demand", async () => {
  state.pods.mockRejectedValue(new Error("Forbidden"));
  state.slices.mockResolvedValue([]);
  const object = {
    metadata: { namespace: "sample", name: "web" },
    spec: { selector: { app: "web" } },
    getNs: () => "sample",
    getName: () => "web",
  };
  const view = render(<ServiceDiagnosticsDetails object={object as never} />);
  const refresh = view.getByRole("button", { name: "Refresh evidence" });
  expect(view.getByRole("heading", { name: "Service backend diagnostics" }).contains(refresh)).toBe(true);
  expect((refresh as HTMLButtonElement).disabled).toBe(true);

  await waitFor(() => expect(view.getByText(/Partial evidence/)).toBeTruthy());
  expect(view.getByText(/Pod data unavailable/)).toBeTruthy();
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  expect(state.slices).toHaveBeenCalledWith(
    { namespace: "sample" },
    { labelSelector: "kubernetes.io/service-name=web" },
  );
  fireEvent.click(view.getByRole("button", { name: "Refresh evidence" }));
  await waitFor(() => expect(state.pods).toHaveBeenCalledTimes(2));
});
it("shows replica bounds and reason evidence for the HPA", () => {
  const view = render(
    <HpaDiagnosticsDetails
      object={
        {
          spec: { minReplicas: 2, maxReplicas: 2 },
          status: {
            currentReplicas: 2,
            desiredReplicas: 2,
            conditions: [{ type: "ScalingLimited", status: "True", reason: "TooFewReplicas" }],
          },
        } as never
      }
    />,
  );
  expect(view.getByText(/Replica count is fixed/)).toBeTruthy();
  expect(view.getByText(/Current 2 · desired 2 · min 2 · max 2/)).toBeTruthy();
  expect(view.getByText(/TooFewReplicas/)).toBeTruthy();
});

it("bounds backend links and expands them on demand", async () => {
  const pods = Array.from({ length: 7 }, (_, i) => ({
    metadata: { uid: `pod-${i}`, name: `web-${i}`, namespace: "sample", labels: { app: "web" } },
    getName: () => `web-${i}`,
    selfLink: `/api/v1/namespaces/sample/pods/web-${i}`,
  }));
  state.pods.mockResolvedValue(pods);
  state.slices.mockResolvedValue([]);
  const view = render(
    <ServiceDiagnosticsDetails
      object={
        {
          metadata: { namespace: "sample", name: "web" },
          spec: { selector: { app: "web" } },
          getNs: () => "sample",
          getName: () => "web",
        } as never
      }
    />,
  );
  await waitFor(() => expect(view.getByRole("button", { name: "Show 2 more resources" })).toBeTruthy());
  expect(view.queryByRole("button", { name: "web-6" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show 2 more resources" }));
  expect(view.getByRole("button", { name: "web-6" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Show fewer resources" }));
  expect(view.queryByRole("button", { name: "web-6" })).toBeNull();
});

it("does not show successful evidence when a ready backend lacks a matching Service port", async () => {
  state.pods.mockResolvedValue([
    {
      metadata: { name: "web-1", namespace: "sample", labels: { app: "web" } },
      status: { conditions: [{ type: "Ready", status: "True" }] },
      getName: () => "web-1",
    },
  ]);
  state.slices.mockResolvedValue([
    {
      metadata: { name: "web-a", namespace: "sample", labels: { "kubernetes.io/service-name": "web" } },
      addressType: "IPv4",
      endpoints: [{ addresses: ["192.0.2.1"], conditions: { ready: true } }],
      ports: [],
      getName: () => "web-a",
    },
  ]);
  const view = render(
    <ServiceDiagnosticsDetails
      object={
        {
          metadata: { namespace: "sample", name: "web" },
          spec: { selector: { app: "web" }, ports: [{ port: 80 }] },
          getNs: () => "sample",
          getName: () => "web",
        } as never
      }
    />,
  );
  await waitFor(() => expect(view.getByText(/Partial evidence; matching EndpointSlice/)).toBeTruthy());
  expect(view.getByText(/Partial evidence; matching EndpointSlice/).style.color).toBe("var(--textColorSecondary)");
});
