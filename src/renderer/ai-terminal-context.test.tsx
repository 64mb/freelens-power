// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiTerminalContext, activeAiTerminal, captureAiTerminal } from "./ai-terminal-context";

const mocks = vi.hoisted(() => ({
  clusterId: "cluster-a",
  connected: true,
  lines: ["ready", "EXAMPLE=sensitive"],
  sendCommand: vi.fn(),
  useEvents: false,
  listener: undefined as (() => void) | undefined,
  dispose: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: mocks.clusterId } }) } },
    Component: {
      Icon: () => null,
      terminalStore: {
        isConnected: () => mocks.connected,
        getTerminalApi: () => ({ isReady: mocks.connected, isConnected: () => mocks.connected }),
        getTerminal: () => ({
          xterm: {
            get onWriteParsed() {
              return mocks.useEvents
                ? (listener: () => void) => {
                    mocks.listener = listener;
                    return { dispose: mocks.dispose };
                  }
                : undefined;
            },
            buffer: {
              active: {
                get length() {
                  return mocks.lines.length;
                },
                baseY: 0,
                get cursorY() {
                  return 0;
                },
                getLine: (index: number) =>
                  mocks.lines[index] === undefined ? undefined : { translateToString: () => mocks.lines[index] },
              },
            },
          },
        }),
        sendCommand: mocks.sendCommand,
      },
    },
  },
}));
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  mocks.clusterId = "cluster-a";
  mocks.connected = true;
  mocks.lines = ["ready", "EXAMPLE=sensitive"];
  mocks.useEvents = false;
  mocks.listener = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
const terminal = () => {
  const element = document.createElement("div");
  element.dataset.testid = "dock-tab-content-for-terminal-a";
  document.body.append(element);
  return element;
};
describe("terminal snapshot capture", () => {
  it("only reads the visible connected terminal in the current cluster", () => {
    const element = terminal();
    expect(activeAiTerminal("cluster-a")).toBe("terminal-a");
    expect(captureAiTerminal("cluster-a")?.text).toBe("ready\nEXAMPLE=[REDACTED]");
    expect(captureAiTerminal("cluster-a", "other-terminal")).toBeUndefined();
    expect(captureAiTerminal("cluster-b")).toBeUndefined();
    element.hidden = true;
    expect(captureAiTerminal("cluster-a")).toBeUndefined();
    element.hidden = false;
    mocks.connected = false;
    expect(captureAiTerminal("cluster-a")).toBeUndefined();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
  it("recaptures current output rather than retaining a previous snapshot", () => {
    terminal();
    expect(captureAiTerminal("cluster-a")?.text).toContain("ready");
    mocks.lines = ["new output"];
    expect(captureAiTerminal("cluster-a")?.text).toBe("new output");
    mocks.clusterId = "cluster-b";
    expect(captureAiTerminal("cluster-a")).toBeUndefined();
  });
  it("refreshes and redacts the attached preview on terminal output without sending a question", () => {
    vi.useFakeTimers();
    terminal();
    mocks.useEvents = true;
    const onChange = vi.fn();
    const view = render(
      <AiTerminalContext
        clusterId="cluster-a"
        attachment={{ clusterId: "cluster-a", terminalId: "terminal-a" }}
        onChange={onChange}
        disabled={false}
      />,
    );
    expect(view.container.querySelector("pre")?.textContent).toBe("ready\nEXAMPLE=[REDACTED]");
    mocks.lines = ["fresh output", "EXAMPLE=new-sensitive"];
    act(() => {
      mocks.listener?.();
      vi.advanceTimersByTime(250);
    });
    expect(view.container.querySelector("pre")?.textContent).toBe("fresh output\nEXAMPLE=[REDACTED]");
    expect(screen.queryByText(/new-sensitive/)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    mocks.lines = [""];
    act(() => {
      mocks.listener?.();
      vi.advanceTimersByTime(250);
    });
    expect(view.container.querySelector("pre")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    mocks.lines = ["output after clear"];
    act(() => {
      mocks.listener?.();
      vi.advanceTimersByTime(250);
    });
    expect(view.container.querySelector("pre")?.textContent).toBe("output after clear");
    const caption = screen.getByText(/Preview captured/).textContent;
    act(() => {
      vi.advanceTimersByTime(2000);
      mocks.listener?.();
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText(/Preview captured/).textContent).toBe(caption);
    act(() => {
      mocks.listener?.();
    });
    view.unmount();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses polling without output events and stops refreshing when its terminal disappears", () => {
    vi.useFakeTimers();
    const element = terminal();
    const onChange = vi.fn();
    const view = render(
      <AiTerminalContext
        clusterId="cluster-a"
        attachment={{ clusterId: "cluster-a", terminalId: "terminal-a" }}
        onChange={onChange}
        disabled={false}
      />,
    );
    mocks.lines = ["polled output", "TOKEN=private"];
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(view.container.querySelector("pre")?.textContent).toBe("polled output\nTOKEN=[REDACTED]");
    element.remove();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText(/polled output/)).toBeNull();
    const changes = onChange.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onChange).toHaveBeenCalledTimes(changes);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to unattached and requires an explicit click without executing", () => {
    terminal();
    const onChange = vi.fn();
    render(<AiTerminalContext clusterId="cluster-a" onChange={onChange} disabled={false} />);
    const button = screen.getByLabelText("Attach terminal output");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith({ clusterId: "cluster-a", terminalId: "terminal-a" });
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
});
