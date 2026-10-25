// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiResizeHandle, clampAiPanelWidth } from "./ai-resize";
import { MockTooltip } from "./native-tooltip.test-utils";

beforeEach(() => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI panel resize handle", () => {
  it("resizes from the left edge and clamps against the workspace", () => {
    const change = vi.fn();
    render(<AiResizeHandle width={560} available={1000} onChange={change} />);
    const handle = screen.getByRole("separator", { name: "Resize AI assistant" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 440, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200, pointerId: 1 });
    expect(change).toHaveBeenLastCalledWith(660);
    fireEvent.pointerUp(window, { clientX: -1000, clientY: 200, pointerId: 1 });
    expect(change).toHaveBeenLastCalledWith(1000);
    expect(clampAiPanelWidth(900, 320)).toBe(320);
    expect(clampAiPanelWidth(100, 1000)).toBe(360);
  });

  it("resets after one short click and never resets after movement out and back", () => {
    const change = vi.fn();
    render(<AiResizeHandle width={700} available={1000} onChange={change} />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 302, clientY: 101 });
    expect(change).toHaveBeenLastCalledWith(560);
    change.mockClear();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 280, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 100 });
    expect(change).toHaveBeenLastCalledWith(700);
    expect(change.mock.calls.some(([width]) => width === 560)).toBe(false);
  });

  it("supports accessible arrow adjustments and Home reset", () => {
    const change = vi.fn();
    render(<AiResizeHandle width={700} available={1000} onChange={change} />);
    const handle = screen.getByRole("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("700");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(change).toHaveBeenLastCalledWith(720);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(change).toHaveBeenLastCalledWith(680);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(change).toHaveBeenLastCalledWith(560);
  });

  it("does not reset after canceled or vertically moved gestures", () => {
    const change = vi.fn();
    render(<AiResizeHandle width={700} available={1000} onChange={change} />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerUp(window, { clientX: 300, clientY: 100 });
    expect(change).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 200 });
    expect(change).toHaveBeenLastCalledWith(700);
  });
});

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MockTooltip {...props} /> } },
}));
