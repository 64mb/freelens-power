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
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

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

import { AiAttachmentReceipts, AiContextPreview, AiResourceReferences, openAiResourceReference } from "./ai-extras";

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

  it("highlights attached JSON without changing redacted evidence or enabling field actions", () => {
    const summary =
      '{\n  "message": "<img src=x onerror=alert(1)>",\n  "token": "[REDACTED]",\n  "count": 3, "ready": true, "missing": null\n}';
    const context = { clusterId: "cluster-a", screen: "/pods", resource: reference };
    const view = render(
      <AiContextPreview context={context} finding={{ clusterId: "cluster-a", title: "Log line", summary }} />,
    );
    const evidence = screen.getByLabelText("Selected diagnostic finding").querySelector("pre")!;
    const metadata = view.container.querySelector(".power-ai-context-content pre")!;
    expect(evidence.textContent).toBe(JSON.stringify(JSON.parse(summary), null, 2));
    expect(metadata.textContent).toBe(JSON.stringify(context, null, 2));
    expect(evidence.querySelector('[data-token="key"]')?.textContent).toBe('"message"');
    expect(evidence.querySelector('[data-token="string"]')?.textContent).toContain("<img");
    expect(evidence.querySelector('[data-token="number"]')?.textContent).toBe("3");
    expect(evidence.querySelector('[data-token="literal"]')?.textContent).toBe("true");
    expect(metadata.querySelector('[data-token="key"]')?.textContent).toBe('"clusterId"');
    expect(evidence.querySelector("img")).toBeNull();
    for (const token of view.container.querySelectorAll<HTMLElement>("[data-token]")) {
      fireEvent.mouseEnter(token);
      fireEvent.focus(token);
      expect(token.hasAttribute("tabindex")).toBe(false);
    }
    expect(screen.queryByRole("toolbar", { name: "JSON field actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy value" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Include value" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exclude value" })).toBeNull();
    view.unmount();
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

it("keeps selected evidence in one removable row within the composer", () => {
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
    [...view.container.querySelectorAll("summary")].filter((element) =>
      element.textContent?.endsWith("Context metadata"),
    ),
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
  const tooltip = within(view.container).getByText("Remove diagnostic finding");
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.id).not.toBe("");
  expect(tooltip.getAttribute("data-target-id")).toBe(button.id);
  expect(tooltip.textContent).toBe("Remove diagnostic finding");
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

it("uses the same removable cards for resource and evidence, and read-only cards in history", () => {
  const remove = vi.fn();
  const resource = { kind: "Pod", name: "worker", namespace: "sample" };
  const view = render(
    <AiContextPreview
      context={{ resource }}
      resource={resource}
      onRemoveResource={remove}
      finding={{ clusterId: "cluster-a", title: "Evidence", summary: '{"count":9007199254740993}' }}
    />,
  );
  const cards = [...view.container.querySelectorAll(".power-ai-attachment-card")];
  expect(cards).toHaveLength(2);
  expect(cards[0].getAttribute("aria-label")).toBe("Attached resource");
  expect(cards[1].querySelector("pre")?.textContent).toBe('{\n  "count": 9007199254740993\n}');
  fireEvent.click(screen.getByLabelText("Remove attached resource"));
  expect(remove).toHaveBeenCalledOnce();
  view.rerender(
    <AiAttachmentReceipts
      attachments={[
        { kind: "resource", title: "Pod/worker", text: JSON.stringify(resource) },
        { kind: "terminal", title: "Terminal", text: '{"ready":true}\n{"count":2}' },
      ]}
    />,
  );
  expect(view.container.querySelectorAll(".power-ai-attachment-card")).toHaveLength(2);
  expect(view.container.querySelectorAll("button")).toHaveLength(0);
  expect(view.container.querySelectorAll('[data-token="key"]')).toHaveLength(5);
  view.unmount();
});

it("preserves ordinary multiline prose and highlights truncated structured output", () => {
  const prose = "Review {the output}:\n  unchanged indentation\nhttps://example.invalid/path";
  const view = render(<AiAttachmentReceipts attachments={[{ kind: "evidence", title: "Notes", text: prose }]} />);
  expect(view.container.querySelector("pre")?.textContent).toBe(prose);
  expect(view.container.querySelector("[data-token]")).toBeNull();
  view.rerender(
    <AiAttachmentReceipts attachments={[{ kind: "terminal", title: "Terminal", text: '{"count": 42,' }]} />,
  );
  expect(view.container.querySelector("pre")?.textContent).toBe('{"count": 42,');
  expect(view.container.querySelector('[data-token="number"]')?.textContent).toBe("42");
  view.unmount();
});
