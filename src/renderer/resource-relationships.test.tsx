// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  namespace: vi.fn(),
  service: vi.fn(),
  pods: vi.fn(),
  slices: vi.fn(),
  ingress: vi.fn(),
  owners: vi.fn(),
  details: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster" } }) } },
    Component: {
      Icon: () => null,
      Select: ({ value, options, onChange, isDisabled, ...props }: any) => (
        <select
          aria-label={props["aria-label"]}
          value={value}
          disabled={isDisabled}
          onChange={(event) => onChange(options.find((option: any) => option.value === event.target.value))}
        >
          {options.map((option: any) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ),
    },
    Navigation: { showDetails: state.details },
    K8sApi: {
      namespacesApi: { list: state.namespace },
      serviceApi: { list: state.service },
      podsApi: { list: state.pods },
      endpointSliceApi: { list: state.slices },
      ingressApi: { list: state.ingress },
      replicaSetApi: { list: state.owners },
      deploymentApi: { list: state.owners },
      statefulSetApi: { list: state.owners },
      daemonSetApi: { list: state.owners },
      jobApi: { list: state.owners },
      cronJobApi: { list: state.owners },
    },
  },
}));

import { buildResourceRelationships } from "../common/resource-relationships";
import { loadRelationshipInventory, RelationshipGraph, ResourceRelationshipsPage } from "./resource-relationships";

const svc = (namespace = "sample") => ({
  metadata: { name: "web", namespace },
  spec: { selector: { app: "web" } },
  getName: () => "web",
  selfLink: `/api/v1/namespaces/${namespace}/services/web`,
});
beforeEach(() => {
  state.namespace.mockResolvedValue([{ getName: () => "sample" }, { getName: () => "other" }]);
  state.service.mockImplementation(({ namespace }) => Promise.resolve([svc(namespace)]));
  state.pods.mockResolvedValue([]);
  state.slices.mockResolvedValue([]);
  state.ingress.mockResolvedValue([]);
  state.owners.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
it("does not query APIs while disabled", () => {
  render(<ResourceRelationshipsPage enabled={false} />);
  expect(state.namespace).not.toHaveBeenCalled();
  expect(state.pods).not.toHaveBeenCalled();
});
it("opens a graph resource without letting the same click close its native drawer", () => {
  const onOpen = vi.fn();
  const closeDrawer = vi.fn();
  const outsideClick = (event: MouseEvent) => {
    if (!event.defaultPrevented) closeDrawer();
  };
  window.addEventListener("click", outsideClick);
  try {
    const view = render(
      <RelationshipGraph graph={buildResourceRelationships(svc(), {})} onOpen={onOpen} ingressAvailable />,
    );
    const button = view.getByRole("button", { name: "web" });
    fireEvent.mouseDown(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith("/api/v1/namespaces/sample/services/web");
    expect(closeDrawer).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("click", outsideClick);
  }
});
it("keeps denied evidence unknown and uses bounded namespace requests", async () => {
  state.pods.mockRejectedValue(new Error("Forbidden"));
  const view = render(<ResourceRelationshipsPage />);
  await waitFor(() => expect(view.getByText(/Partial coverage/)).toBeTruthy());
  expect(view.getByText(/selector relationships are unknown/)).toBeTruthy();
  expect(state.pods).toHaveBeenCalledWith(expect.objectContaining({ namespace: "other" }), {
    limit: 101,
    labelSelector: "app=web",
  });
  state.details.mockRejectedValue(new Error("Unavailable"));
  fireEvent.click(view.getByRole("button", { name: "web" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("could not be opened"));
});
it("aborts old namespace requests and ignores their late responses", async () => {
  let resolvePods: (value: unknown[]) => void = () => {};
  state.pods
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePods = resolve;
        }),
    )
    .mockResolvedValue([]);
  const view = render(<ResourceRelationshipsPage />);
  await waitFor(() => expect(state.pods).toHaveBeenCalledTimes(1));
  const signal = state.pods.mock.calls[0][0].reqInit.signal;
  fireEvent.change(view.getByLabelText("Relationship namespace"), { target: { value: "sample" } });
  await waitFor(() => expect(state.pods).toHaveBeenCalledTimes(2));
  expect(signal.aborted).toBe(true);
  resolvePods([{ metadata: { name: "stale-pod", namespace: "sample", labels: { app: "web" } } }]);
  await waitFor(() => expect(view.getAllByText(/No relationships observed/)[0]).toBeTruthy());
  expect(view.queryByText("stale-pod")).toBeNull();
});

it("draws actual card-to-card edges through gutters and highlights incident connections", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const position: Record<string, [number, number]> = {
      service: [220, 100],
      "pod/pod-1": [440, 100],
      "owner/rs-1": [660, 100],
      "owner/deploy-1": [660, 260],
    };
    const [left, top] = position[this.dataset.nodeId ?? ""] ?? [0, 0];
    return {
      left,
      top,
      right: left + 180,
      bottom: top + 100,
      width: 180,
      height: 100,
      x: left,
      y: top,
      toJSON: () => ({}),
    };
  });
  const graph = buildResourceRelationships(
    { metadata: { name: "web", namespace: "sample" }, spec: { selector: { app: "web" } } },
    {
      pods: [
        {
          metadata: {
            uid: "pod-1",
            name: "web-1",
            namespace: "sample",
            labels: { app: "web" },
            ownerReferences: [{ uid: "rs-1", name: "replica", kind: "ReplicaSet" }],
          },
          selfLink: "/pod",
        },
      ],
      slices: [],
      owners: [
        {
          metadata: {
            uid: "rs-1",
            namespace: "sample",
            ownerReferences: [{ uid: "deploy-1", name: "workload", kind: "Deployment" }],
          },
        },
      ],
    },
  );
  const view = render(<RelationshipGraph graph={graph} onOpen={vi.fn()} ingressAvailable />);
  const selected = view.container.querySelector('[data-edge-from="service"][data-edge-to="pod/pod-1"]');
  expect(selected?.getAttribute("d")).toBe("M 400 150 H 440");
  const owner = view.container.querySelector('[data-edge-from="owner/rs-1"]');
  expect(owner?.getAttribute("d")).toMatch(/^M 660 150 L /);
  expect(owner?.getAttribute("d")).toContain(" Q ");
  expect(owner?.getAttribute("d")).toMatch(/ L 660 310$/);
  expect(view.container.querySelector<HTMLElement>(".graph")?.style.gridTemplateRows).toBe("auto repeat(2, auto)");
  fireEvent.focus(view.getByRole("button", { name: "web-1" }));
  expect(selected?.getAttribute("class")).toContain("highlighted");
  expect(owner?.getAttribute("class")).toContain("dimmed");
  fireEvent.blur(view.getByRole("button", { name: "web-1" }));
  expect(selected?.getAttribute("class")).toBe("connection");
});

it("skips pod, EndpointSlice and controller queries for ExternalName even with a leftover selector", async () => {
  await loadRelationshipInventory(
    "sample",
    { ...svc(), spec: { selector: { app: "web" }, type: "ExternalName", externalName: "example.invalid" } } as never,
    new AbortController().signal,
  );
  expect(state.pods).not.toHaveBeenCalled();
  expect(state.slices).not.toHaveBeenCalled();
  expect(state.owners).not.toHaveBeenCalled();
  expect(state.ingress).toHaveBeenCalledTimes(1);
});

it("hides upstream resources and their edges while preserving backend connections", () => {
  const graph = buildResourceRelationships(svc(), {
    pods: [{ metadata: { uid: "pod-1", name: "web-1", namespace: "sample", labels: { app: "web" } } }],
    slices: [],
    ingresses: [
      { metadata: { name: "entry", namespace: "sample" }, spec: { defaultBackend: { service: { name: "web" } } } },
    ],
  });
  const view = render(<RelationshipGraph graph={graph} onOpen={vi.fn()} ingressAvailable />);
  expect(view.getByRole("region", { name: "Upstream references" })).toBeTruthy();
  expect(view.container.querySelectorAll(".connection").length).toBe(graph.edges.length);
  view.rerender(<RelationshipGraph graph={graph} onOpen={vi.fn()} ingressAvailable hideUpstreams />);
  expect(view.queryByRole("region", { name: "Upstream references" })).toBeNull();
  expect(view.container.querySelectorAll(".column").length).toBe(3);
  expect(view.container.querySelector(".graph.hide-upstreams")).toBeTruthy();
  const visibleIds = new Set(graph.nodes.filter((node) => node.role !== "upstream").map((node) => node.id));
  expect(view.container.querySelectorAll(".connection").length).toBe(
    graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)).length,
  );
  view.rerender(<RelationshipGraph graph={graph} onOpen={vi.fn()} ingressAvailable />);
  expect(view.getByRole("region", { name: "Upstream references" })).toBeTruthy();
});
