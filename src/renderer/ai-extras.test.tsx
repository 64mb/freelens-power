// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachedAiContext } from "../common/ai-extras";

const state = vi.hoisted(() => ({
  clusterId: "cluster-a",
  get: vi.fn(),
  getUrl: vi.fn(),
  showDetails: vi.fn(),
  getApi: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.clusterId } }) } },
    K8sApi: { apiManager: { getApiByKind: state.getApi } },
    Navigation: { showDetails: state.showDetails },
  },
}));

import { AiContextPreview, openAiResourceReference } from "./ai-extras";

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
