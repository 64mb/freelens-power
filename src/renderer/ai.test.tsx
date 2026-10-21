// @vitest-environment jsdom
import { serialize } from "node:v8";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiLauncherBottom, readAiContext, startAiChat } from "./ai";

const mocks = vi.hoisted(() => ({
  clusterId: "cluster-a",
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]) => ({ text: "Ready" })),
  preferences: {
    enabled: true,
    chatFontSize: 14,
    model: "",
    speed: "default",
    systemPrompt: "Help",
    clusterPrompt: "Review",
    conversations: {} as Record<string, { role: string; text: string }[]>,
    setMessages(key: string, messages: { role: string; text: string }[]) {
      this.conversations[key] = messages;
    },
  },
}));
vi.mock("../common/store/ai-shortcuts-store", () => ({
  AiShortcutsStore: {
    getInstanceOrCreate: () => ({
      shortcuts: [
        { id: "inspect", command: "inspect", label: "Inspect workload", prompt: "Inspect this workload" },
        { id: "health", command: "health", label: "Cluster health", prompt: "Review health" },
      ],
    }),
  },
}));

vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));
vi.mock("../common/store/ai-preferences-store", () => ({
  AiPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {},
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: mocks.clusterId } }) } },
  },
}));
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  mocks.preferences.conversations = {};
  vi.clearAllMocks();
});
describe("AI chat", () => {
  it("removes all AI entry points when disabled and preserves conversation history", async () => {
    const previous = mocks.preferences;
    const preferences = observable({
      ...previous,
      conversations: { "cluster-a": [{ role: "assistant", text: "Saved reply" }] },
    });
    mocks.preferences = preferences;
    try {
      document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
      stop = startAiChat(() => true);
      fireEvent.click(screen.getByLabelText("Open AI assistant"));
      expect(screen.getByLabelText("AI assistant")).toBeTruthy();
      act(() => {
        runInAction(() => {
          preferences.enabled = false;
        });
      });
      await waitFor(() => expect(screen.queryByLabelText("AI assistant")).toBeNull());
      expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
      expect(screen.queryByRole("button", { name: "Ask about cluster" })).toBeNull();
      window.dispatchEvent(new Event("power-ai-open"));
      expect(screen.queryByLabelText("AI assistant")).toBeNull();
      expect(preferences.conversations["cluster-a"][0].text).toBe("Saved reply");
      act(() => {
        runInAction(() => {
          preferences.enabled = true;
        });
      });
      await waitFor(() => expect(screen.getByLabelText("Open AI assistant")).toBeTruthy());
      expect(screen.queryByLabelText("AI assistant")).toBeNull();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      stop?.();
      stop = undefined;
      mocks.preferences = previous;
    }
  });

  it("sends persisted observable history as cloneable IPC data", async () => {
    mocks.preferences.conversations["cluster-a"] = observable([{ role: "assistant", text: "Previous reply" }]);
    mocks.invoke.mockImplementationOnce(async (_channel: unknown, request: unknown) => {
      expect(() => serialize(request)).not.toThrow();
      return { text: "Next reply", reads: [{ method: "pods", status: "ok" }] };
    });
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(3));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('.power-ai-read-activity [data-method="pods"]')?.getAttribute("data-status")).toBe(
      "ok",
    );
    fireEvent.click(screen.getByLabelText("New chat"));
    expect(document.querySelector(".power-ai-read-activity")).toBeNull();
  });

  it("attaches only route metadata and ignores arbitrary query contents", () => {
    window.history.replaceState(
      {},
      "",
      "/workloads?kube-details=%2Fapi%2Fv1%2Fnamespaces%2Fdefault%2Fpods%2Fexample&token=ignored",
    );
    expect(readAiContext()).toEqual({
      clusterId: "cluster-a",
      screen: "/workloads",
      resource: { namespace: "default", kind: "pods", name: "example" },
    });
  });
  it("sends a cluster conversation and removes all extension nodes on disposal", async () => {
    window.history.replaceState({}, "", "/overview");
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    stop = startAiChat(() => true);
    await waitFor(() => expect(screen.getByLabelText("Open AI assistant")).toBeTruthy());
    expect(document.querySelector(".power-ai-launcher .Icon.material > .icon")?.textContent).toBe(
      "chat_bubble_outline",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const overview = document.querySelector('[data-testid="cluster-overview-page"]');
    expect(overview?.previousElementSibling?.className).toBe("power-ai-overview-actions");
    expect(overview?.contains(screen.getByRole("button", { name: "Ask about cluster" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Ask about cluster" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about cluster" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
    expect(mocks.invoke).toHaveBeenCalledWith(
      "freelens-power:ai-chat",
      expect.objectContaining({
        context: { clusterId: "cluster-a", screen: "/overview" },
        systemPrompt: "Help\n\nReview",
        messages: [{ role: "user", text: "Review" }],
      }),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    stop();
    stop = undefined;
    expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about cluster" })).toBeNull();
  });
  it("only opens existing cluster history and never resends it", async () => {
    window.history.replaceState({}, "", "/overview");
    mocks.preferences.conversations["cluster-a"] = [{ role: "user", text: "Earlier question" }];
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    stop = startAiChat(() => true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "Ask about cluster" }));
    expect(screen.getByText("Earlier question")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("sends Enter once while preserving Shift+Enter and IME composition", async () => {
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "Inspect pods" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  });
  it("shows live read activity only for the matching pending request", async () => {
    let finish: (response: { text: string }) => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect pods" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    const request = mocks.invoke.mock.calls[0][1] as { requestId: string };
    const listener = mocks.on.mock.calls.find(([channel]) => channel === "freelens-power:ai-read-activity")?.[1];
    expect(listener).toBeTruthy();
    act(() => listener({}, { requestId: "stale", method: "pods", status: "reading" }));
    expect(document.querySelector('[data-status="reading"]')).toBeNull();
    act(() => listener({}, { requestId: request.requestId, method: "pods", status: "reading" }));
    expect(document.querySelector('[data-method="pods"]')?.textContent).toContain("reading");
    act(() => listener({}, { requestId: request.requestId, method: "pods", status: "ok" }));
    expect(document.querySelector('[data-method="pods"]')?.getAttribute("data-status")).toBe("ok");
    await act(async () => finish({ text: "Ready" }));
    act(() => listener({}, { requestId: request.requestId, method: "nodes", status: "reading" }));
    expect(document.querySelector('[data-method="nodes"]')).toBeNull();
  });
  it("isolates close and Escape from host dropdown handlers", async () => {
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const outsideClick = vi.fn();
    const outsideEscape = vi.fn();
    document.addEventListener("click", outsideClick);
    document.addEventListener("keydown", outsideEscape);
    try {
      fireEvent.click(screen.getByLabelText("Close AI assistant"));
      expect(outsideClick).not.toHaveBeenCalled();
      fireEvent.click(screen.getByLabelText("Open AI assistant"));
      outsideClick.mockClear();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByLabelText("AI assistant")).toBeNull();
      expect(outsideEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", outsideClick);
      document.removeEventListener("keydown", outsideEscape);
    }
  });
  it("fades at a resource list bottom and restores when scrolling up while ignoring sidebar scroll", () => {
    window.history.replaceState({}, "", "/workloads");
    document.body.innerHTML =
      '<main class="KubeObjectListLayout"><div id="resource-scroll"></div></main><aside class="Sidebar"></aside>';
    stop = startAiChat(() => true);
    const list = document.getElementById("resource-scroll")!;
    const sidebar = document.querySelector("aside")!;
    for (const element of [list, sidebar])
      Object.defineProperties(element, {
        scrollHeight: { value: 1000 },
        clientHeight: { value: 200 },
        scrollTop: { value: 800, writable: true },
      });
    fireEvent.scroll(sidebar);
    expect(screen.getByLabelText("Open AI assistant").getAttribute("aria-hidden")).toBeNull();
    fireEvent.scroll(list);
    const launcher = document.querySelector<HTMLButtonElement>(".power-ai-launcher")!;
    expect(launcher.getAttribute("aria-hidden")).toBe("true");
    expect(launcher.tabIndex).toBe(-1);
    list.scrollTop = 400;
    fireEvent.scroll(list);
    expect(launcher.getAttribute("aria-hidden")).toBeNull();
    expect(launcher.tabIndex).toBe(0);
  });
  it("updates the chat font variable when the preference changes", () => {
    const previous = mocks.preferences;
    mocks.preferences = observable({ ...previous });
    try {
      window.history.replaceState({}, "", "/overview");
      stop = startAiChat(() => true);
      fireEvent.click(screen.getByLabelText("Open AI assistant"));
      expect(screen.getByLabelText("AI assistant").style.getPropertyValue("--power-ai-font-size")).toBe("14px");
      act(() =>
        runInAction(() => {
          mocks.preferences.chatFontSize = 18;
        }),
      );
      expect(screen.getByLabelText("AI assistant").style.getPropertyValue("--power-ai-font-size")).toBe("18px");
    } finally {
      stop?.();
      stop = undefined;
      mocks.preferences = previous;
    }
  });
  it("completes shortcuts with arrows and Enter before sending and Escape dismisses only suggestions", () => {
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/health ");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/workload" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
    expect(input.value).toBe("/workload");
    fireEvent.change(input, { target: { value: "/ins" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(input.value).toBe("/ins");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/inspect ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "freelens-power:ai-chat",
      expect.objectContaining({ messages: [{ role: "user", text: "Inspect this workload" }] }),
    );
  });
  it("keeps the reading position when an answer arrives above the bottom", async () => {
    let finish: (response: { text: string }) => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Review" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    const messages = document.querySelector<HTMLElement>(".power-ai-messages")!;
    Object.defineProperties(messages, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 100, writable: true },
    });
    fireEvent.scroll(messages);
    await act(async () => finish({ text: "Ready" }));
    expect(messages.scrollTop).toBe(100);
  });
  it("keeps a 16px launcher gap above the visible Dock and falls back when hidden", () => {
    document.body.innerHTML = '<div class="Dock"></div>';
    const dock = document.querySelector<HTMLElement>(".Dock")!;
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ top: 400, width: 1000, height: 200 } as DOMRect);
    expect(aiLauncherBottom()).toBe(window.innerHeight - 400 + 16);
    stop = startAiChat(() => true);
    expect(screen.getByLabelText("Open AI assistant").style.bottom).toBe(`${window.innerHeight - 400 + 16}px`);
    dock.style.display = "none";
    expect(aiLauncherBottom()).toBe(16);
    fireEvent(window, new Event("resize"));
    expect(screen.getByLabelText("Open AI assistant").style.bottom).toBe("16px");
  });
  it("closes outside without interfering with host clicks and stays open when pinned", () => {
    window.history.replaceState({}, "", "/overview");
    const hostButton = document.createElement("button");
    hostButton.textContent = "Host navigation";
    document.body.append(hostButton);
    const hostClick = vi.fn();
    hostButton.addEventListener("click", hostClick);
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.click(screen.getByLabelText("Message"));
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
    fireEvent.click(hostButton);
    expect(hostClick).toHaveBeenCalledTimes(1);
    expect(hostClick.mock.calls[0][0].defaultPrevented).toBe(false);
    expect(screen.queryByLabelText("AI assistant")).toBeNull();
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.click(screen.getByRole("button", { name: "Pin AI assistant" }));
    expect(screen.getByRole("button", { name: "Pin AI assistant" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hostButton);
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin AI assistant" }));
    fireEvent.click(hostButton);
    expect(screen.queryByLabelText("AI assistant")).toBeNull();
    expect(hostClick).toHaveBeenCalledTimes(3);
  });
  it("does not show AI on global pages", () => {
    stop = startAiChat(() => false);
    expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about cluster" })).toBeNull();
  });
  it("moves the launcher away from resource details and hides it during host dialogs", async () => {
    window.history.replaceState({}, "", "/workloads?kube-details=%2Fapi%2Fv1%2Fnodes%2Fexample");
    stop = startAiChat(() => true);
    expect(screen.getByLabelText("Open AI assistant").style.left).toBe("16px");
    stop();
    window.history.replaceState({}, "", "/overview");
    document.body.innerHTML = '<div role="dialog">Host dialog</div>';
    stop = startAiChat(() => true);
    expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
    document.querySelector('[role="dialog"]')?.remove();
    await waitFor(() => expect(screen.getByLabelText("Open AI assistant")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
  });
  it("keeps oversized drafts and never sends a different question", async () => {
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "x".repeat(20_001) } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value.length).toBe(20_001);
    expect(screen.getByRole("alert").textContent).toContain("too long");
  });
});
