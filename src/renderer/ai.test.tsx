// @vitest-environment jsdom

import { serialize } from "node:v8";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiLauncherBottom, aiLauncherLeft, readAiContext, startAiChat } from "./ai";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";

import type { AiMessage } from "../common/store/ai-preferences-store";

const mocks = vi.hoisted(() => ({
  clusterId: "cluster-a",
  terminalOutput: "initial output",
  sendCommand: vi.fn(),
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
    conversations: {} as Record<string, AiMessage[]>,
    setMessages(key: string, messages: AiMessage[]) {
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
    Component: {
      Tooltip: (props: any) => <MockTooltip {...props} />,
      Icon: () => {
        throw new Error("Native injected Icon requires the host React DI context");
      },
      terminalStore: {
        isConnected: () => true,
        getTerminalApi: () => ({ isReady: true, isConnected: () => true }),
        getTerminal: () => ({
          xterm: {
            buffer: {
              active: {
                length: 1,
                baseY: 0,
                cursorY: 0,
                getLine: (index: number) =>
                  index === 0 ? { translateToString: () => mocks.terminalOutput } : undefined,
              },
            },
          },
        }),
        sendCommand: mocks.sendCommand,
      },
    },
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: mocks.clusterId } }) } },
  },
}));
let stop: (() => void) | undefined;
afterEach(async () => {
  await act(async () => {});
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  mocks.preferences.conversations = {};
  vi.clearAllMocks();
});
describe("AI chat", () => {
  it("does not refresh screen context for native tooltip mutations but still reacts to drawers", async () => {
    stop = startAiChat(() => true);
    await act(async () => {});
    const query = vi.spyOn(document, "querySelector");
    const dockReads = () => query.mock.calls.filter(([selector]) => selector === ".Dock").length;
    try {
      const tooltip = document.createElement("div");
      tooltip.className = "Tooltip narrow left formatter";
      await act(async () => {
        document.body.append(tooltip);
      });
      await act(async () => {
        tooltip.style.left = "100px";
        tooltip.style.top = "200px";
      });
      await act(async () => {
        tooltip.remove();
      });
      expect(dockReads()).toBe(0);
      await act(async () => {
        const drawer = document.createElement("aside");
        drawer.className = "Drawer KubeObjectDetails";
        document.body.append(drawer);
      });
      expect(dockReads()).toBeGreaterThan(0);
    } finally {
      query.mockRestore();
    }
  });
  it("preserves attachment across panel close and refreshes its preview and send-time output", async () => {
    document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
    mocks.invoke.mockResolvedValue({ text: "Ready" });
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const attach = screen.getByLabelText("Attach terminal output");
    expect(attach.textContent?.trim()).toBe("terminal");
    const triggerStyle = getComputedStyle(attach.parentElement!);
    expect(triggerStyle.position).toBe("absolute");
    expect(triggerStyle.right).toBe(triggerStyle.top);
    expect(attach.style.borderColor).toBe("var(--borderFaintColor)");
    expect(attach.style.color).toBe("var(--textColorSecondary)");
    expect(tooltipText(attach)).toBe("Attach terminal output to this question");
    fireEvent.click(attach);
    expect(attach.getAttribute("aria-pressed")).toBe("true");
    expect(tooltipText(attach)).toBe("Detach terminal output from this question");
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    mocks.terminalOutput = "fresh reopened output";
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("fresh reopened output")).toBeTruthy();
    const terminalSummary = screen.getByText(/^Terminal · \d+ rows/);
    expect(terminalSummary.closest(".power-ai-attachment-card")).toBeTruthy();
    expect(screen.queryByText(/^Preview ·/)).toBeNull();
    mocks.terminalOutput = "fresh send-time output";
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
    expect(mocks.invoke.mock.calls.at(-1)?.[1]).toHaveProperty("terminalSnapshot.text", "fresh send-time output");
    expect(mocks.preferences.conversations["cluster-a"][0].attachments).toEqual([
      expect.objectContaining({ kind: "terminal", text: "fresh send-time output" }),
    ]);
  });
  it("preserves attachment through search overlay clicks and refreshes the preview when it disappears", async () => {
    document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.click(screen.getByLabelText("Attach terminal output"));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-freelens-power-ai-overlay", "");
    document.body.append(dialog);
    await waitFor(() => expect(screen.queryByLabelText("AI assistant")).toBeNull());
    fireEvent.click(dialog);
    mocks.terminalOutput = "fresh post-overlay output";
    dialog.remove();
    await waitFor(() => expect(screen.getByLabelText("AI assistant")).toBeTruthy());
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("fresh post-overlay output")).toBeTruthy();
    expect(JSON.stringify(mocks.preferences.conversations)).not.toContain("fresh post-overlay output");
  });
  it("clears a hidden panel attachment when its terminal changes", async () => {
    document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.click(screen.getByLabelText("Attach terminal output"));
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    document.querySelector('[data-testid="dock-tab-content-for-terminal-a"]')?.remove();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    document.body.insertAdjacentHTML("beforeend", '<div data-testid="dock-tab-content-for-terminal-a"></div>');
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("false");
  });
  it("recaptures explicitly attached output, saves a receipt and consumes it after success", async () => {
    document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
    mocks.terminalOutput = "preview output";
    mocks.invoke.mockResolvedValue({ text: "Ready" });
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByLabelText("Attach terminal output"));
    expect(screen.getByText("preview output")).toBeTruthy();
    mocks.terminalOutput = "current output\nEXAMPLE=sensitive";
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect terminal" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "freelens-power:ai-chat",
      expect.objectContaining({
        terminalSnapshot: expect.objectContaining({ text: "current output\nEXAMPLE=sensitive" }),
      }),
    );
    expect(mocks.preferences.conversations["cluster-a"][0].attachments).toEqual([
      expect.objectContaining({ kind: "terminal", text: "current output\nEXAMPLE=sensitive" }),
    ]);
    expect(JSON.stringify(mocks.preferences.conversations)).not.toContain("preview output");
    expect(JSON.stringify(mocks.preferences.conversations)).toContain("EXAMPLE=sensitive");
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(4));
    expect(mocks.invoke.mock.calls.at(-1)?.[1]).not.toHaveProperty("terminalSnapshot");
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
  it("removes all AI entry points when disabled and preserves conversation history", async () => {
    const previous = mocks.preferences;
    const preferences = observable({
      ...previous,
      conversations: { "cluster-a": [{ role: "assistant" as const, text: "Saved reply" }] },
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
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
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
    act(() => stop?.());
    stop = undefined;
    expect(screen.queryByLabelText("Open AI assistant")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about cluster" })).toBeNull();
  });
  it("opens an empty AI conversation without sending when requested by a page action", async () => {
    window.history.replaceState({}, "", "/power-logs");
    await act(async () => {
      stop = startAiChat(() => true);
    });
    act(() => {
      window.dispatchEvent(new Event("power-ai-open-only"));
    });
    expect(await screen.findByLabelText("AI assistant")).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    expect(mocks.preferences.conversations["cluster-a"] ?? []).toHaveLength(0);
    expect(mocks.invoke).not.toHaveBeenCalled();
    act(() => stop?.());
    stop = undefined;
    act(() => {
      window.dispatchEvent(new Event("power-ai-open-only"));
    });
    expect(screen.queryByLabelText("AI assistant")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("adds SQLite draft guidance only when the user sends from Power Logs", async () => {
    window.history.replaceState({}, "", "/power-logs");
    await act(async () => {
      stop = startAiChat(() => true);
    });
    act(() => {
      window.dispatchEvent(new Event("power-ai-open-only"));
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Draft an errors query" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    const request = mocks.invoke.mock.calls.find(([channel]) => channel === "freelens-power:ai-chat")![1] as {
      systemPrompt: string;
      messages: AiMessage[];
    };
    expect(request.systemPrompt).toContain("logs(timestamp INTEGER");
    expect(request.systemPrompt).toContain("Draft queries only: never execute them");
    expect(request.messages).toEqual([{ role: "user", text: "Draft an errors query" }]);
    act(() => {
      window.dispatchEvent(new Event("power-ai-close"));
    });
    expect(screen.queryByLabelText("AI assistant")).toBeNull();
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
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
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
    const listener = mocks.on.mock.calls
      .filter(([channel]) => channel === "freelens-power:ai-read-activity")
      .at(-1)?.[1];
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
  it("keeps progress and partial answers while hidden and ignores stale request events", async () => {
    let finish: (response: { text: string }) => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect progress" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    const request = mocks.invoke.mock.calls[0][1] as { requestId: string };
    const listener = mocks.on.mock.calls.filter(([channel]) => channel === "freelens-power:ai-progress").at(-1)?.[1];
    expect(listener).toBeTruthy();
    act(() => listener({}, { requestId: "stale", phase: "answer", elapsedMs: 9000, round: 1, text: "Stale answer" }));
    expect(screen.queryByText("Stale answer")).toBeNull();
    act(() => listener({}, { requestId: request.requestId, phase: "reading", elapsedMs: 2000, round: 1 }));
    expect(screen.getByRole("status").textContent).toContain("Reading resources · 2s");
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    expect(screen.queryByLabelText("AI assistant")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    act(() =>
      listener(
        {},
        { requestId: request.requestId, phase: "answer", elapsedMs: 5000, round: 2, text: "Partial response" },
      ),
    );
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.getByText("Partial response")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Preparing answer · 5s");
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    await act(async () => finish({ text: "Completed response" }));
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(screen.getByText("Completed response")).toBeTruthy();
    expect(screen.queryByText("Partial response")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    act(() =>
      listener({}, { requestId: request.requestId, phase: "answer", elapsedMs: 6000, round: 2, text: "Late response" }),
    );
    expect(screen.queryByText("Late response")).toBeNull();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Next question" } });
    let finishNext: (response: { text: string }) => void = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNext = resolve;
        }),
    );
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    act(() =>
      listener(
        {},
        { requestId: request.requestId, phase: "reading", elapsedMs: 8000, round: 3, text: "Previous response" },
      ),
    );
    expect(screen.queryByText("Previous response")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Thinking · 0s");
    await act(async () => finishNext({ text: "Next response" }));
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
  it("keeps the launcher inside the left workspace edge as the native sidebar resizes", () => {
    window.history.replaceState({}, "", "/workloads?kube-details=legacy-resource");
    document.body.innerHTML = '<div data-testid="cluster-sidebar"></div><div class="Dock"></div>';
    const sidebar = document.querySelector<HTMLElement>('[data-testid="cluster-sidebar"]')!;
    const dock = document.querySelector<HTMLElement>(".Dock")!;
    const bounds = vi
      .spyOn(sidebar, "getBoundingClientRect")
      .mockReturnValue({ right: 220, width: 220, height: 500 } as DOMRect);
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ left: 220, top: 500, width: 700, height: 30 } as DOMRect);
    expect(aiLauncherLeft()).toBe(236);
    stop = startAiChat(() => true);
    expect(screen.getByLabelText("Open AI assistant").style.left).toBe("236px");
    bounds.mockReturnValue({ right: 300, width: 300, height: 500 } as DOMRect);
    fireEvent(window, new Event("resize"));
    expect(screen.getByLabelText("Open AI assistant").style.left).toBe("316px");
    sidebar.hidden = true;
    dock.style.display = "none";
    fireEvent(window, new Event("resize"));
    expect(screen.getByLabelText("Open AI assistant").style.left).toBe("16px");
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
    const pinButton = screen.getByRole("button", { name: "Pin AI assistant" });
    expect(pinButton.querySelector(".Icon.material .icon")?.textContent).toBe("push_pin");
    expect(pinButton.querySelector("svg")).toBeNull();
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pinButton);
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");
    expect(pinButton.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(pinButton.querySelector("path")?.getAttribute("d")).toBeTruthy();
    fireEvent.click(hostButton);
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
    fireEvent.click(pinButton);
    expect(pinButton.querySelector(".Icon.material .icon")?.textContent).toBe("push_pin");
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");
    expect(pinButton.querySelector("svg")).toBeNull();
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

it("stops the originating request, ignores late progress and replies, and clears cancellation state", async () => {
  let finish!: (response: { text: string }) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  window.history.replaceState({}, "", "/overview");
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect pods" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const request = mocks.invoke.mock.calls[0][1] as { requestId: string };
  const listener = mocks.on.mock.calls.filter(([channel]) => channel === "freelens-power:ai-read-activity").at(-1)?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
  expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:ai-cancel", request.requestId);
  act(() => listener({}, { requestId: request.requestId, method: "pods", status: "reading" }));
  expect(document.querySelector('[data-method="pods"]')).toBeNull();
  await act(async () => finish({ text: "Late answer" }));
  expect(mocks.preferences.conversations["cluster-a"]).toEqual([]);
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Inspect pods");
  expect(screen.queryByText("Late answer")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Response stopped");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss cancellation" }));
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Try again" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the explicitly attached resource after the host drawer closes until it is removed", async () => {
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  stop = startAiChat(() => true);
  const launcher = screen.getByLabelText("Open AI assistant");
  fireEvent.pointerDown(launcher);
  act(() => {
    window.history.replaceState({}, "", "/pods");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  fireEvent.click(launcher);
  fireEvent.click(screen.getByRole("button", { name: "Pin AI assistant" }));
  fireEvent.focus(screen.getByLabelText("Message"));
  expect(screen.getByLabelText("Attached resource").textContent).toContain("pods/worker");
  const expected = { kind: "pods", name: "worker", namespace: "default" };
  expect(JSON.parse(document.querySelector(".power-ai-context-content pre")!.textContent!).resource).toEqual(expected);
  for (const question of ["Inspect the attached pod", "Check it again"]) {
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
    expect(mocks.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ context: { resource: expected } });
  }
  fireEvent.click(screen.getByLabelText("Remove attached resource"));
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
  expect(JSON.parse(document.querySelector(".power-ai-context-content pre")!.textContent!).resource).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Review the cluster" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((mocks.invoke.mock.calls.at(-1)?.[1] as { context: { resource?: unknown } }).context.resource).toBeUndefined();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
});

it("ignores a newly opened drawer in pinned chat on keyboard focus", async () => {
  window.history.replaceState({}, "", "/pods");
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  fireEvent.click(screen.getByRole("button", { name: "Pin AI assistant" }));
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  fireEvent.focus(screen.getByLabelText("Message"));
  act(() => {
    window.history.replaceState({}, "", "/pods");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
  act(() => {
    window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  fireEvent.focus(screen.getByLabelText("Message"));
  fireEvent.mouseDown(screen.getByLabelText("Message"));
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Review cluster" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((mocks.invoke.mock.calls.at(-1)?.[1] as { context: { resource?: unknown } }).context.resource).toBeUndefined();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
});

it("keeps selected findings intact and previews the same resource that the next message sends", async () => {
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() =>
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      title: "Selected deployment",
      summary: "Readiness failed",
      resource: { kind: "Deployment", name: "backend", namespace: "sample" },
    }),
  );
  expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
  expect(screen.getByLabelText("Attached resource").textContent).toContain("Deployment/backend");
  const preview = document.querySelector(".power-ai-context-content pre")!.textContent!;
  expect(JSON.parse(preview).resource).toEqual({ kind: "Deployment", name: "backend", namespace: "sample" });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect finding" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((mocks.invoke.mock.calls.at(-1)?.[1] as { context: unknown }).context).toEqual(JSON.parse(preview));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
  expect(screen.getByLabelText("Attached resource").textContent).toContain("Deployment/backend");
});

it("clears explicit resources on new conversations and cluster changes without restoring old attachments", () => {
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
  expect(JSON.parse(document.querySelector(".power-ai-context-content pre")!.textContent!).resource).toBeUndefined();
  fireEvent.click(screen.getByLabelText("Close AI assistant"));
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  act(() => {
    mocks.clusterId = "cluster-b";
    window.history.replaceState({}, "", "/overview");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
  act(() => {
    mocks.clusterId = "cluster-a";
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
});

it("previews the exact attached metadata before sending and persists safe related resource chips", async () => {
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  mocks.invoke.mockResolvedValueOnce({
    text: "Inspect worker",
    references: [{ apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" }],
  } as never);
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  const preview = document.querySelector(".power-ai-context-inspector pre")?.textContent;
  expect(preview).toContain('"namespace": "default"');
  expect(preview).not.toContain("systemPrompt");
  expect(preview).not.toContain("kube-details");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect this pod" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const request = mocks.invoke.mock.calls[0][1] as { context: unknown };
  expect(preview).toBe(JSON.stringify(request.context, null, 2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pod/worker · default" })).toBeTruthy());
  expect(mocks.preferences.conversations["cluster-a"][1]).toMatchObject({
    references: [{ apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" }],
  });
});

it("leaves double Shift to resource search and preserves the chat draft", () => {
  stop = startAiChat(() => true);
  const tap = (target: Window | Element) => {
    fireEvent.keyDown(target, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyUp(target, { key: "Shift", code: "ShiftLeft" });
  };
  tap(window);
  tap(window);
  expect(screen.queryByLabelText("AI assistant")).toBeNull();
  expect(screen.getByLabelText("Open AI assistant").title).not.toContain("Shift");
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Unsent draft" } });
  tap(input);
  tap(input);
  expect(input.value).toBe("Unsent draft");
  expect(screen.getByLabelText("AI assistant")).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("clamps the persisted panel width to the available workspace and resets width with Home", async () => {
  const previous = mocks.preferences;
  const preferences = observable({
    ...previous,
    chatPanelWidth: 740,
    setChatPanelWidth(width: number) {
      this.chatPanelWidth = width;
    },
  });
  mocks.preferences = preferences;
  const previousWidth = window.innerWidth;
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    window.history.replaceState({}, "", "/overview");
    stop = startAiChat(() => true);
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    const panel = screen.getByLabelText("AI assistant");
    expect(panel.style.width).toBe("740px");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(preferences.chatPanelWidth).toBe(760);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    expect(preferences.chatPanelWidth).toBe(560);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    fireEvent.resize(window);
    await waitFor(() => expect(panel.style.width).toBe("320px"));
    expect(preferences.chatPanelWidth).toBe(560);
    expect(screen.getByLabelText("AI assistant")).toBeTruthy();
  } finally {
    stop?.();
    stop = undefined;
    mocks.preferences = previous;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  }
});

it("keeps the launcher right normally and moves it left only while resource details are open", async () => {
  window.history.replaceState({}, "", "/overview");
  document.body.innerHTML = '<div data-testid="cluster-sidebar"></div><div class="Dock"></div>';
  const sidebar = document.querySelector<HTMLElement>('[data-testid="cluster-sidebar"]')!;
  const dock = document.querySelector<HTMLElement>(".Dock")!;
  vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({ right: 220, width: 220, height: 500 } as DOMRect);
  vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ left: 220, top: 500, width: 700, height: 30 } as DOMRect);
  stop = startAiChat(() => true);
  const launcher = screen.getByLabelText("Open AI assistant");
  expect(launcher.style.right).toBe("16px");
  expect(launcher.style.left).toBe("auto");
  window.history.replaceState({}, "", "/pods?kube-details=legacy-resource");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(launcher.style.left).toBe("236px");
  expect(launcher.style.right).toBe("auto");
  expect(launcher.style.bottom).toBe(`${window.innerHeight - 500 + 16}px`);
  window.history.replaceState({}, "", "/pods");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(launcher.style.left).toBe("auto");
  expect(launcher.style.right).toBe("16px");
  const details = document.createElement("div");
  details.className = "Drawer KubeObjectDetails";
  vi.spyOn(details, "getBoundingClientRect").mockReturnValue({ width: 500, height: 700 } as DOMRect);
  document.body.append(details);
  await waitFor(() => expect(launcher.style.left).toBe("236px"));
  details.hidden = true;
  await waitFor(() => expect(launcher.style.right).toBe("16px"));
});

it("filters previously persisted related resources against the saved answer without rewriting history", () => {
  const message: AiMessage = {
    role: "assistant",
    text: "The first pod is worker",
    references: [
      { apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" },
      { apiVersion: "v1", kind: "Pod", name: "unrelated", namespace: "default" },
    ],
  };
  mocks.preferences.conversations["cluster-a"] = [message];
  stop = startAiChat(() => true);
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  expect(screen.getByRole("button", { name: "Pod/worker · default" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pod/unrelated · default" })).toBeNull();
  expect(mocks.preferences.conversations["cluster-a"]).toEqual([message]);
  expect(message.references).toHaveLength(2);
});

it("explains chat controls on hover while leaving Send and Stop without tooltips", async () => {
  let finish: (response: unknown) => void = () => {};
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  stop = startAiChat(() => true);
  expect(tooltipText(screen.getByLabelText("Open AI assistant"))).toContain("Open AI assistant");
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  for (const button of document.querySelectorAll<HTMLButtonElement>(".power-ai-panel button")) {
    if (button.getAttribute("aria-label") === "Send") expect(button.hasAttribute("title")).toBe(false);
    else expect(tooltipText(button)).not.toBe("");
  }
  expect(tooltipText(document.querySelector(".power-ai-context-inspector summary"))).toContain("metadata");
  expect(tooltipText(screen.getByRole("separator"))).toContain("Drag to resize");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "/" } });
  for (const option of screen.getAllByRole("option")) expect(tooltipText(option)).toContain("Insert /");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy());
  expect(screen.getByRole("button", { name: "Stop response" }).hasAttribute("title")).toBe(false);
  await act(async () => finish({ text: "Ready" }));
});

it("shortens the overview action only beside horizontal custom metrics and tracks resizing", () => {
  let width = 1103;
  const callbacks = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(private callback: () => void) {}
      observe(target: Element) {
        this.targets.add(target);
        callbacks.set(target, this.callback);
      }
      disconnect() {
        for (const target of this.targets) callbacks.delete(target);
      }
    },
  );
  try {
    document.body.innerHTML =
      '<div data-testid="cluster-overview-page"><div data-freelens-power-monitoring></div></div>';
    const overview = document.querySelector<HTMLElement>('[data-testid="cluster-overview-page"]')!;
    Object.defineProperty(overview, "clientWidth", { get: () => width });
    stop = startAiChat(() => true);
    const button = screen.getByRole("button", { name: "Ask AI about cluster" });
    expect(button.textContent).toContain("Ask AI");
    expect(tooltipText(button)).toContain("cluster");
    width = 600;
    act(() => callbacks.get(overview)?.());
    expect(button.textContent).toContain("Ask about cluster");
    width = 1103;
    act(() => callbacks.get(overview)?.());
    expect(button.textContent).toContain("Ask AI");
    act(() => stop?.());
    stop = undefined;
    expect(callbacks.has(overview)).toBe(false);
  } finally {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  }
});

describe("selected diagnostic findings", () => {
  const finding = () => ({
    clusterId: "cluster-a",
    title: "Pending workload",
    summary: "Insufficient CPU on available nodes",
    resource: { kind: "Pod", namespace: "sample", name: "worker" },
  });
  const attach = async (value = finding()) => {
    const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
    act(() => {
      explainDiagnosticFinding(value);
    });
  };
  it("opens a reviewable finding without sending and preserves the current draft", async () => {
    mocks.clusterId = "cluster-a";
    act(() => {
      stop = startAiChat(() => true);
    });
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "My investigation question" } });
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    await attach();
    expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain("Insufficient CPU");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("My investigation question");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.preferences.conversations).toEqual({});
  });
  it("suggests a starting question only for a new empty conversation", async () => {
    mocks.clusterId = "cluster-a";
    act(() => {
      stop = startAiChat(() => true);
    });
    await attach();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "Explain this finding and suggest the next read-only checks.",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("attaches context to an existing conversation without populating its blank draft", async () => {
    mocks.clusterId = "cluster-a";
    mocks.preferences.conversations["cluster-a"] = [{ role: "assistant", text: "Previous investigation" }];
    act(() => {
      stop = startAiChat(() => true);
    });
    await attach();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Previous investigation")).toBeTruthy();
    expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("reads current cluster history at attachment time after restoring a different conversation", async () => {
    mocks.clusterId = "cluster-b";
    act(() => {
      stop = startAiChat(() => true);
    });
    mocks.preferences.conversations["cluster-a"] = [{ role: "assistant", text: "Restored investigation" }];
    mocks.clusterId = "cluster-a";
    await attach();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Restored investigation")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("preserves a draft including whitespace in an existing conversation", async () => {
    mocks.clusterId = "cluster-a";
    mocks.preferences.conversations["cluster-a"] = [{ role: "assistant", text: "Previous investigation" }];
    act(() => {
      stop = startAiChat(() => true);
    });
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  " } });
    await attach();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("  ");
  });
  it("sends bounded selected evidence and persists attachment receipts", async () => {
    mocks.clusterId = "cluster-a";
    mocks.invoke.mockResolvedValue({ text: "Ready" });
    act(() => {
      stop = startAiChat(() => true);
    });
    await attach({ ...finding(), summary: "evidence ".repeat(1000) });
    const preview = screen.getByLabelText("Selected diagnostic finding").querySelector("pre")!.textContent!;
    expect(preview).toHaveLength(6000);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect this pod" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
    const payload = mocks.invoke.mock.calls.at(-1)?.[1] as { messages: { text: string }[]; context: unknown };
    expect(payload.messages.at(-1)?.text).toContain(preview);
    expect(payload.context).toMatchObject({ clusterId: "cluster-a", resource: finding().resource });
    expect(mocks.preferences.conversations["cluster-a"][0]).toMatchObject({
      role: "user",
      text: "Inspect this pod",
      attachments: [
        expect.objectContaining({ kind: "resource" }),
        expect.objectContaining({ kind: "evidence", text: preview }),
      ],
    });
    expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  });
  it("removing evidence keeps the separately attached resource in the next request", async () => {
    mocks.clusterId = "cluster-a";
    act(() => {
      stop = startAiChat(() => true);
    });
    await attach();
    fireEvent.click(screen.getByLabelText("Remove diagnostic finding"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "General question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    const payload = mocks.invoke.mock.calls.at(-1)?.[1] as {
      messages: { text: string }[];
      context: { resource?: unknown };
    };
    expect(payload.messages.at(-1)?.text).toBe("General question");
    expect(payload.context.resource).toEqual(finding().resource);
  });
  it("ignores findings for another cluster and clears an attachment on cluster navigation", async () => {
    mocks.clusterId = "cluster-a";
    act(() => {
      stop = startAiChat(() => true);
    });
    await attach({ ...finding(), clusterId: "cluster-b" });
    expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
    await attach();
    expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
    act(() => {
      mocks.clusterId = "cluster-b";
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
    act(() => {
      mocks.clusterId = "cluster-a";
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  });
});

it("requests visible screen evidence on opening and preserves an existing conversation draft", async () => {
  mocks.clusterId = "cluster-a";
  mocks.preferences.conversations["cluster-a"] = [{ role: "assistant", text: "Previous investigation" }];
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  const attach = vi.fn(() =>
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      source: "relationships",
      title: "Relationships · example",
      summary: "Service example connected to Pod worker",
    }),
  );
  window.addEventListener("power-ai-request-screen-context", attach);
  try {
    act(() => {
      stop = startAiChat(() => true);
    });
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(attach).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain("Relationships · example");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    expect(mocks.invoke).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("power-ai-request-screen-context", attach);
  }
});

it("preserves already attached evidence when reopening AI instead of requesting the map", async () => {
  mocks.clusterId = "cluster-a";
  const request = vi.fn();
  window.addEventListener("power-ai-request-screen-context", request);
  try {
    act(() => {
      stop = startAiChat(() => true);
    });
    const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
    act(() => {
      explainDiagnosticFinding({
        clusterId: "cluster-a",
        source: "logs",
        title: "Selected logs",
        summary: "Existing evidence",
      });
    });
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    fireEvent.click(screen.getByLabelText("Open AI assistant"));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain("Selected logs");
  } finally {
    window.removeEventListener("power-ai-request-screen-context", request);
  }
});

it("sends a large bounded relationship map within the question budget", async () => {
  mocks.clusterId = "cluster-a";
  mocks.invoke.mockResolvedValue({ text: "Ready" });
  const { relationshipMapFinding } = await import("./relationship-map-finding");
  const { buildResourceRelationships } = await import("../common/resource-relationships");
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  const graph = buildResourceRelationships({ metadata: { name: "example", namespace: "sample" } }, {});
  graph.nodes = Array.from({ length: 60 }, (_, index) => ({
    ...graph.nodes[0],
    id: `node-${index}`,
    name: `resource-${index}`,
    detail: '"'.repeat(300),
  }));
  const finding = relationshipMapFinding("cluster-a", "sample", "example", graph, false);
  expect(finding.summary.length).toBeLessThanOrEqual(8000);
  expect(JSON.parse(finding.summary).omitted).toBeGreaterThan(0);
  act(() => {
    stop = startAiChat(() => true);
  });
  act(() => {
    explainDiagnosticFinding(finding);
  });
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Explain the map" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
  const payload = mocks.invoke.mock.calls.at(-1)?.[1] as { messages: { text: string }[] };
  expect(payload.messages.at(-1)!.text).toContain("Relationships · example");
  expect(payload.messages.at(-1)!.text.length).toBeLessThan(20_000);
});

it("explicitly replaces a finding resource while passive navigation retains the attached resource", async () => {
  window.history.replaceState({}, "", "/overview");
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() => {
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      title: "Resource A",
      summary: "Evidence A",
      resource: { kind: "Pod", name: "first", namespace: "sample" },
    });
  });
  expect(screen.getByLabelText("Attached resource").textContent).toContain("Pod/first");
  act(() => {
    window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/sample/pods/second");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByLabelText("Attached resource").textContent).toContain("Pod/first");
  expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
  act(() => window.dispatchEvent(new Event("power-ai-open-only")));
  expect(screen.getByLabelText("Attached resource").textContent).toContain("pods/second");
  expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect second" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
  const payload = mocks.invoke.mock.calls.at(-1)?.[1] as {
    messages: { text: string }[];
    context: { resource: unknown };
  };
  expect(payload.context.resource).toEqual({ kind: "pods", name: "second", namespace: "sample" });
  expect(payload.messages.at(-1)?.text).toBe("Inspect second");
});

it("accepts automatic evidence only with empty slots and respects dismissal after reopening", async () => {
  window.history.replaceState({}, "", "/overview");
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  const automatic = () =>
    act(() => {
      explainDiagnosticFinding({
        clusterId: "cluster-a",
        automatic: true,
        title: "Automatic evidence",
        summary: "Current snapshot",
        resource: { kind: "Pod", name: "auto", namespace: "sample" },
      });
    });
  automatic();
  expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain("Automatic evidence");
  fireEvent.click(screen.getByLabelText("Remove diagnostic finding"));
  automatic();
  expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Remove attached resource"));
  fireEvent.click(screen.getByLabelText("Close AI assistant"));
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  automatic();
  expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  expect(screen.queryByLabelText("Attached resource")).toBeNull();
});

it("ignores automatic evidence while a terminal attachment is present", async () => {
  window.history.replaceState({}, "", "/overview");
  document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
  act(() => {
    stop = startAiChat(() => true);
  });
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  fireEvent.click(screen.getByLabelText("Attach terminal output"));
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() => {
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      automatic: true,
      title: "Automatic evidence",
      summary: "Snapshot",
    });
  });
  expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
});

it("retains attachments and restores the draft on failure, then stores receipts on successful retry", async () => {
  window.history.replaceState({}, "", "/overview");
  document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
  mocks.invoke.mockRejectedValueOnce(new Error("FREELENS_AI_CLI_FAILURE"));
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() => {
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      title: "Evidence A",
      summary: "Snapshot A",
      resource: { kind: "Pod", name: "first", namespace: "sample" },
    });
  });
  fireEvent.click(screen.getByLabelText("Attach terminal output"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect attachments" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(mocks.preferences.conversations["cluster-a"]).toEqual([]);
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Inspect attachments");
  expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2));
  expect(mocks.preferences.conversations["cluster-a"][0].attachments?.map((item) => item.kind)).toEqual([
    "resource",
    "evidence",
    "terminal",
  ]);
  expect(screen.queryByLabelText("Selected diagnostic finding")).toBeNull();
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("false");
});

it("consumes only the sent snapshot when new evidence is attached during a response", async () => {
  window.history.replaceState({}, "", "/overview");
  let finish!: (response: { text: string }) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  const attach = (name: string) =>
    act(() => {
      explainDiagnosticFinding({
        clusterId: "cluster-a",
        title: `Evidence ${name}`,
        summary: `Snapshot ${name}`,
        resource: { kind: "Pod", name, namespace: "sample" },
      });
    });
  attach("first");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect first" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  attach("second");
  await act(async () => finish({ text: "Ready" }));
  expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain("Evidence second");
  expect(screen.getByLabelText("Attached resource").textContent).toContain("Pod/second");
  expect(
    mocks.preferences.conversations["cluster-a"][0].attachments?.find((item) => item.kind === "evidence")?.text,
  ).toBe("Snapshot first");
});

it("restores a canceled draft and keeps its resource, evidence and terminal attachments", async () => {
  window.history.replaceState({}, "", "/overview");
  document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
  let finish!: (response: { text: string }) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() => {
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      title: "Selected evidence",
      summary: "Snapshot",
      resource: { kind: "Pod", name: "first", namespace: "sample" },
    });
  });
  fireEvent.click(screen.getByLabelText("Attach terminal output"));
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect attachments" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
  await act(async () => finish({ text: "Late reply" }));
  expect(mocks.preferences.conversations["cluster-a"]).toEqual([]);
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Inspect attachments");
  expect(screen.getByLabelText("Selected diagnostic finding")).toBeTruthy();
  expect(screen.getByLabelText("Attached resource")).toBeTruthy();
  expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByText("Late reply")).toBeNull();
});

it("rolls back pending attachment receipts on shutdown and ignores the late response", async () => {
  window.history.replaceState({}, "", "/overview");
  const original: AiMessage[] = [{ role: "assistant", text: "Previous investigation" }];
  mocks.preferences.conversations["cluster-a"] = original;
  let finish!: (response: { text: string }) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    stop = startAiChat(() => true);
  });
  const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
  act(() => {
    explainDiagnosticFinding({
      clusterId: "cluster-a",
      title: "Pending evidence",
      summary: "Snapshot not sent successfully",
      resource: { kind: "Pod", name: "worker", namespace: "sample" },
    });
  });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Inspect pending evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const request = mocks.invoke.mock.calls.at(-1)?.[1] as { requestId: string };
  expect(mocks.preferences.conversations["cluster-a"]).toHaveLength(2);
  expect(mocks.preferences.conversations["cluster-a"][1].attachments?.map((item) => item.kind)).toEqual([
    "resource",
    "evidence",
  ]);
  act(() => {
    stop?.();
    stop = undefined;
  });
  expect(mocks.preferences.conversations["cluster-a"]).toEqual(original);
  expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:ai-cancel", request.requestId);
  await act(async () => finish({ text: "Late response after shutdown" }));
  expect(mocks.preferences.conversations["cluster-a"]).toEqual(original);
  expect(JSON.stringify(mocks.preferences.conversations)).not.toContain("Pending evidence");
});

it("allows automatic context on reopening after terminal invalidation in another cluster", async () => {
  window.history.replaceState({}, "", "/relationships");
  document.body.innerHTML = '<div data-testid="dock-tab-content-for-terminal-a"></div>';
  act(() => {
    stop = startAiChat(() => true);
  });
  fireEvent.click(screen.getByLabelText("Open AI assistant"));
  fireEvent.click(screen.getByLabelText("Attach terminal output"));
  expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("true");
  try {
    await act(async () => {
      mocks.clusterId = "cluster-b";
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByLabelText("Attach terminal output").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByLabelText("Close AI assistant"));
    const { explainDiagnosticFinding } = await import("./ai-diagnostic-handoff");
    const request = vi.fn(() => {
      explainDiagnosticFinding({
        clusterId: "cluster-b",
        automatic: true,
        source: "relationships",
        title: "Relationships in the new cluster",
        summary: '{"nodes":[]}',
      });
    });
    window.addEventListener("power-ai-request-screen-context", request);
    try {
      fireEvent.click(screen.getByLabelText("Open AI assistant"));
      expect(request).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Selected diagnostic finding").textContent).toContain(
        "Relationships in the new cluster",
      );
    } finally {
      window.removeEventListener("power-ai-request-screen-context", request);
    }
  } finally {
    mocks.clusterId = "cluster-a";
  }
});

it("moves the launcher left for a visible native Helm drawer and restores it when the drawer closes", async () => {
  window.history.replaceState({}, "", "/helm");
  document.body.innerHTML = '<div data-testid="cluster-sidebar"></div>';
  const sidebar = document.querySelector<HTMLElement>('[data-testid="cluster-sidebar"]')!;
  vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({ right: 220, width: 220, height: 500 } as DOMRect);
  stop = startAiChat(() => true);
  const launcher = screen.getByLabelText("Open AI assistant");
  expect(launcher.style.left).toBe("auto");
  expect(launcher.style.right).toBe("16px");
  const drawer = document.createElement("div");
  drawer.className = "Drawer helm-native-drawer";
  drawer.style.display = "none";
  vi.spyOn(drawer, "getBoundingClientRect").mockReturnValue({ width: 500, height: 700 } as DOMRect);
  document.body.append(drawer);
  await waitFor(() => expect(launcher.style.right).toBe("16px"));
  drawer.style.display = "block";
  await waitFor(() => expect(launcher.style.left).toBe("236px"));
  expect(launcher.style.right).toBe("auto");
  drawer.hidden = true;
  await waitFor(() => expect(launcher.style.right).toBe("16px"));
  expect(launcher.style.left).toBe("auto");
  drawer.hidden = false;
  await waitFor(() => expect(launcher.style.left).toBe("236px"));
  drawer.remove();
  await waitFor(() => expect(launcher.style.right).toBe("16px"));
  expect(launcher.style.left).toBe("auto");
});
