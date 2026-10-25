// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTooltip } from "./native-tooltip";

import type { ReactNode } from "react";

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MountBoundTooltip {...props} /> } },
}));
afterEach(cleanup);

function MountBoundTooltip({ targetId, children }: { targetId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // the host binds target listeners only on mount
  useEffect(() => {
    const target = document.getElementById(targetId)!;
    const enter = () => setOpen(true);
    const leave = () => setOpen(false);
    target.addEventListener("mouseenter", enter);
    target.addEventListener("mouseleave", leave);
    return () => {
      target.removeEventListener("mouseenter", enter);
      target.removeEventListener("mouseleave", leave);
    };
  }, []);
  return open ? <span role="tooltip">{children}</span> : null;
}

it("rebinds the native tooltip when the provider changes the target element type", () => {
  const view = render(
    <NativeTooltip title="Codex">
      <svg role="img" aria-label="Codex" />
    </NativeTooltip>,
  );
  const previous = screen.getByRole("img", { name: "Codex" });
  fireEvent.mouseEnter(previous);
  expect(screen.getByRole("tooltip").textContent).toBe("Codex");
  fireEvent.mouseLeave(previous);
  view.rerender(
    <NativeTooltip title="Claude">
      <img alt="Claude" />
    </NativeTooltip>,
  );
  fireEvent.mouseEnter(screen.getByRole("img", { name: "Claude" }));
  expect(screen.getByRole("tooltip").textContent).toBe("Claude");
  fireEvent.mouseLeave(previous);
  expect(screen.getByRole("tooltip").textContent).toBe("Claude");
});

it("rebinds native listeners when an explicit target id changes", () => {
  const view = render(
    <NativeTooltip title="First">
      <button id="first">Action</button>
    </NativeTooltip>,
  );
  view.rerender(
    <NativeTooltip title="Second">
      <button id="second">Action</button>
    </NativeTooltip>,
  );
  fireEvent.mouseEnter(screen.getByRole("button"));
  expect(screen.getByRole("tooltip").textContent).toBe("Second");
});
