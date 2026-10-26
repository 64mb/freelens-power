// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { observable } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  items: [] as { selfLink: string; getStatus(): string; getStatusMessage(): string }[],
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-example" } }) } },
    K8sApi: {
      podsStore: {
        get items() {
          return state.items;
        },
      },
    },
    Component: {
      StatusBrick: ({ className, tooltip }: { className: string; tooltip: string }) => (
        <span className={`StatusBrick ${className}`} aria-label={tooltip} />
      ),
    },
  },
}));

import { startPodDetailsEnhancements } from "./pod-details-enhancements";

let stop: (() => void) | undefined;
afterEach(() => {
  act(() => stop?.());
  document.body.innerHTML = "";
});
const path = "/api/v1/namespaces/example/pods/example-pod";
function row(resourcePath = path) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="TableRow"><div class="TableCell name"><div class="badge"><a href="?kube-details=${encodeURIComponent(resourcePath)}"><div class="badge interactive">example-pod</div></a></div></div><div class="TableCell node"><div class="badge"><a href="?kube-details=%2Fapi%2Fv1%2Fnodes%2Fexample-node"><div class="badge interactive">example-node</div></a></div></div></div>`;
  return wrapper.firstElementChild!;
}
function setup() {
  const status = observable({ phase: "Running", message: "Running" });
  state.items = observable.array([
    { selfLink: path, getStatus: () => status.phase, getStatusMessage: () => status.message },
  ]);
  document.body.innerHTML =
    '<div class="KubeObjectDetails"><div class="DeploymentDetails"><div class="PodDetailsList"></div></div></div>';
  const table = document.querySelector(".PodDetailsList")!;
  table.append(row());
  act(() => {
    stop = startPodDetailsEnhancements();
  });
  return { table, status };
}
it("adds a native status brick before the pod name and reacts to pod status changes", async () => {
  const { status } = setup();
  await waitFor(() => expect(document.querySelector(".StatusBrick.running")).not.toBeNull());
  const cell = document.querySelector(".TableCell.name")!;
  expect(cell.firstElementChild?.className).toBe("power-pod-status");
  expect(cell.querySelector(".StatusBrick")?.getAttribute("aria-label")).toBe("Running");
  expect(document.querySelector(".TableCell.node [data-power-pod-name-hover]")).toBeNull();
  act(() => {
    status.phase = "Pending";
    status.message = "ContainerCreating";
  });
  await waitFor(() =>
    expect(cell.querySelector(".StatusBrick.pending")?.getAttribute("aria-label")).toBe("ContainerCreating"),
  );
});
it("handles virtualized rows and restores native markup and styles when disabled", async () => {
  const { table } = setup();
  await waitFor(() => expect(table.querySelector(".StatusBrick")).not.toBeNull());
  table.replaceChildren(row());
  await waitFor(() => expect(table.querySelectorAll(".StatusBrick")).toHaveLength(1));
  act(() => stop?.());
  expect(document.querySelector(".power-pod-status")).toBeNull();
  expect(document.querySelector("[data-power-pod-name-hover]")).toBeNull();
  expect(document.querySelector("[data-power-pod-name]")).toBeNull();
  expect(document.head.querySelector('[data-freelens-power="pod-details-enhancements"]')).toBeNull();
  expect(table.querySelector("a")?.textContent).toBe("example-pod");
  table.append(row());
  await act(async () => {
    await Promise.resolve();
  });
  expect(table.querySelector(".StatusBrick")).toBeNull();
});
it("leaves node drawers and unrelated pod links unchanged", async () => {
  setup();
  const node = document.createElement("div");
  node.className = "KubeObjectDetails";
  node.innerHTML = '<div class="NodeDetails"><div class="PodDetailsList"></div></div>';
  node.querySelector(".PodDetailsList")!.append(row());
  document.body.append(node);
  await waitFor(() => expect(document.querySelector(".DeploymentDetails .StatusBrick")).not.toBeNull());
  expect(node.querySelector(".StatusBrick")).toBeNull();
  expect(node.querySelector("[data-power-pod-name-hover]")).toBeNull();
});
