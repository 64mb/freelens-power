// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { clearRenderedContainers, PortalHost, renderIntoContainer, unmountContainer } from "./react-roots";

afterEach(() => {
  act(clearRenderedContainers);
  cleanup();
  document.body.innerHTML = "";
});

it("renders through the host tree and retains component state when a container updates", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = vi.fn();
  function Counter({ label }: { label: string }) {
    const [count, setCount] = useState(0);
    useEffect(() => dispose, []);
    return (
      <button onClick={() => setCount(count + 1)}>
        {label}: {count}
      </button>
    );
  }
  renderIntoContainer(<Counter label="first" />, container);
  const host = render(<PortalHost />);
  fireEvent.click(container.querySelector("button")!);
  act(() => renderIntoContainer(<Counter label="second" />, container));
  expect(container.textContent).toBe("second: 1");
  act(() => unmountContainer(container));
  expect(container.childNodes).toHaveLength(0);
  expect(dispose).toHaveBeenCalledOnce();
  host.unmount();
});

it("removes all portals and their effects during extension teardown", () => {
  const dispose = vi.fn();
  function Child() {
    useEffect(() => dispose, []);
    return <span>active</span>;
  }
  const targets = [document.createElement("div"), document.createElement("div")];
  targets.forEach((target) => document.body.append(target));
  render(<PortalHost />);
  act(() => targets.forEach((target) => renderIntoContainer(<Child />, target)));
  expect(targets.every((target) => target.textContent === "active")).toBe(true);
  act(clearRenderedContainers);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(targets.every((target) => target.childNodes.length === 0)).toBe(true);
});

it("isolates a failing portal from the host and other extension portals", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failing = document.createElement("div");
  const healthy = document.createElement("div");
  document.body.append(failing, healthy);
  function Broken(): never {
    throw new Error("render failed");
  }
  render(
    <>
      <span>host remains available</span>
      <PortalHost />
    </>,
  );
  act(() => {
    renderIntoContainer(<Broken />, failing);
    renderIntoContainer(<span>healthy portal</span>, healthy);
  });
  expect(failing.querySelector('[role="alert"]')?.textContent).toContain("could not display");
  expect(healthy.textContent).toBe("healthy portal");
  expect(document.body.textContent).toContain("host remains available");
  error.mockRestore();
});
