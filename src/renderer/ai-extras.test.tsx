// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachedAiContext } from "../common/ai-extras";
import { tooltipText } from "./native-tooltip.test-utils";

import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  clusterId: "cluster-a",
  get: vi.fn(),
  getUrl: vi.fn(),
  showDetails: vi.fn(),
  getApi: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Tooltip: ({ targetId, children }: { targetId: string; children?: ReactNode }) => (
        <span role="tooltip" data-target-id={targetId}>
          {children}
        </span>
      ),
    },
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.clusterId } }) } },
    K8sApi: { apiManager: { getApiByKind: state.getApi } },
    Navigation: { showDetails: state.showDetails },
  },
}));

vi.mock("./ai-icon", () => ({
  AiIcon: ({ material }: { material: string }) => (
    <span role="img" aria-label={material} aria-hidden={!["subject", "insights"].includes(material) || undefined}>
      {material}
    </span>
  ),
}));

import { AiContextPreview, AiResourceReferences, openAiResourceReference } from "./ai-extras";

const reference = { apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" };
beforeEach(() => {
  vi.clearAllMocks();
  state.clusterId = "cluster-a";
  state.get.mockResolvedValue({});
  state.getUrl.mockReturnValue("/api/v1/namespaces/default/pods/worker");
  state.getApi.mockReturnValue({ isNamespaced: true, get: state.get, getUrl: state.getUrl });
});

describe("AI context preview and resource navigation", () => {
  it("shows the exact projected payload and no unrelated prompt or resource data", () => {
    const context = attachedAiContext({
      clusterId: "cluster-a",
      screen: "/pods?token=hidden",
      resource: { kind: "Pod", name: "worker", namespace: "default" },
      secret: "hidden",
    } as never);
    render(<AiContextPreview context={context} />);
    const preview = screen.getByText((_, element) => element?.tagName === "PRE");
    expect(preview.textContent).toBe(JSON.stringify(context, null, 2));
    expect(preview.textContent).not.toContain("hidden");
  });

  it("resolves the exact native API and namespace with a read-only GET", async () => {
    await openAiResourceReference("cluster-a", reference);
    expect(state.getApi).toHaveBeenCalledWith("Pod", "v1");
    expect(state.get).toHaveBeenCalledWith({ name: "worker", namespace: "default" });
    expect(state.showDetails).toHaveBeenCalledWith("/api/v1/namespaces/default/pods/worker");
  });

  it("does not read in another cluster or open after a cluster change", async () => {
    state.clusterId = "cluster-b";
    await expect(openAiResourceReference("cluster-a", reference)).rejects.toThrow();
    expect(state.get).not.toHaveBeenCalled();
    state.clusterId = "cluster-a";
    state.get.mockImplementation(async () => {
      state.clusterId = "cluster-b";
      return {};
    });
    await expect(openAiResourceReference("cluster-a", reference)).rejects.toThrow();
    expect(state.showDetails).not.toHaveBeenCalled();
  });

  it("does not navigate when access is denied or the namespace is absent", async () => {
    state.get.mockRejectedValue(new Error("Forbidden"));
    await expect(openAiResourceReference("cluster-a", reference)).rejects.toThrow();
    await expect(openAiResourceReference("cluster-a", { ...reference, namespace: undefined })).rejects.toThrow();
    expect(state.showDetails).not.toHaveBeenCalled();
  });
});

it("closes only after accepted resource navigation and keeps failures open", async () => {
  const onOpened = vi.fn();
  const view = render(
    <AiResourceReferences clusterId="cluster-a" references={[reference]} text="Inspect worker" onOpened={onOpened} />,
  );
  state.showDetails.mockRejectedValueOnce(new Error("Navigation failed"));
  fireEvent.click(screen.getByRole("button", { name: /Pod\/worker/ }));
  await screen.findByRole("alert");
  expect(onOpened).not.toHaveBeenCalled();
  state.showDetails.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: /Pod\/worker/ }));
  await waitFor(() => expect(onOpened).toHaveBeenCalledOnce());
  view.unmount();
});

it("renders compact navigable chips with complete identities available on hover", () => {
  const view = render(<AiResourceReferences clusterId="cluster-a" references={[reference]} text="Inspect worker" />);
  const chip = screen.getByRole("button", { name: "Pod/worker · default" });
  expect(tooltipText(chip)).toBe("Open Pod/worker details · default");
  expect(chip.style.padding).toBe("4px 8px");
  expect(chip.style.fontSize).toBe("12px");
  expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toContain("arrow_forward");
  view.unmount();
});

it("keeps selected evidence in one removable row within Attached context", () => {
  const remove = vi.fn();
  const view = render(
    <AiContextPreview
      context={{ clusterId: "cluster-a", resource: { kind: "Pod", name: "worker", namespace: "sample" } }}
      finding={{ clusterId: "cluster-a", title: "Pod worker is not ready", summary: "Readiness probe failed" }}
      onRemoveFinding={remove}
    />,
  );
  const row = screen.getByLabelText("Selected diagnostic finding");
  expect(row.closest(".power-ai-context-preview")).toBeTruthy();
  expect(row.querySelector("section")).toBeNull();
  expect(
    [...view.container.querySelectorAll("summary")].filter((element) => element.textContent === "Attached context"),
  ).toHaveLength(1);
  expect(row.querySelector("pre")?.textContent).toBe("Readiness probe failed");
  expect(row.querySelector("details")?.open).toBe(false);
  fireEvent.click(screen.getByLabelText("Remove diagnostic finding"));
  expect(remove).toHaveBeenCalledOnce();
  view.unmount();
});

it("distinguishes attached log context from diagnostic findings by its icon", () => {
  const finding = { clusterId: "cluster-a", title: "Selected evidence", summary: "Selected read-only evidence" };
  const view = render(<AiContextPreview context={{}} finding={{ ...finding, source: "logs" }} />);
  const chip = within(screen.getByLabelText("Selected diagnostic finding"));
  expect(chip.getByRole("img", { name: "subject" })).toBeTruthy();
  expect(chip.queryByRole("img", { name: "insights" })).toBeNull();
  view.rerender(<AiContextPreview context={{}} finding={{ ...finding, source: "relationships" }} />);
  expect(view.container.querySelector('[aria-label="account_tree"]')).toBeTruthy();
  view.rerender(<AiContextPreview context={{}} finding={finding} />);
  expect(chip.getByRole("img", { name: "insights" })).toBeTruthy();
  expect(chip.queryByRole("img", { name: "subject" })).toBeNull();
});

it("uses the common tooltip for removing context without a duplicate native title", () => {
  const remove = vi.fn();
  const finding = { clusterId: "cluster-a", title: "Selected evidence", summary: "Read-only evidence" };
  const view = render(<AiContextPreview context={{}} finding={finding} onRemoveFinding={remove} />);
  const button = within(view.container).getByRole("button", { name: "Remove diagnostic finding" });
  const tooltip = within(view.container).getByText("Remove attached finding");
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.id).not.toBe("");
  expect(tooltip.getAttribute("data-target-id")).toBe(button.id);
  expect(tooltip.textContent).toBe("Remove attached finding");
  const targetId = button.id;
  view.rerender(
    <AiContextPreview
      context={{ screen: "/pods" }}
      finding={{ ...finding, title: "Updated evidence" }}
      onRemoveFinding={remove}
    />,
  );
  expect(within(view.container).getByRole("button", { name: "Remove diagnostic finding" }).id).toBe(targetId);
  fireEvent.click(button);
  expect(remove).toHaveBeenCalledTimes(1);
  view.unmount();
});
