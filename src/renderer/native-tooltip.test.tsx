// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTooltip } from "./native-tooltip";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MockTooltip {...props} /> } },
}));
afterEach(cleanup);

it("uses the native tooltip without changing the target layout, ref or action", () => {
  const onClick = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const view = render(
    <NativeTooltip title="Clear local search cache">
      <button ref={ref} type="button" onClick={onClick}>
        Clear
      </button>
    </NativeTooltip>,
  );
  const button = screen.getByRole("button", { name: "Clear" });
  expect(view.container.children).toHaveLength(1);
  expect(ref.current).toBe(button);
  expect(button.hasAttribute("title")).toBe(false);
  expect(tooltipText(button)).toBe("Clear local search cache");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
  const id = button.id;
  view.rerender(
    <NativeTooltip title="Cache cleared">
      <button ref={ref} type="button" onClick={onClick}>
        Clear
      </button>
    </NativeTooltip>,
  );
  expect(button.id).toBe(id);
  expect(tooltipText(button)).toBe("Cache cleared");
});

it("preserves explicit target ids and removes forwarded native title attributes", () => {
  const view = render(
    <NativeTooltip title="Explain finding">
      <button id="existing-action" title="Browser tooltip">
        Explain
      </button>
    </NativeTooltip>,
  );
  const button = screen.getByRole("button", { name: "Explain" });
  expect(button.id).toBe("existing-action");
  expect(button.hasAttribute("title")).toBe(false);
  expect(tooltipText(button)).toBe("Explain finding");
  view.unmount();
  expect(document.querySelector('[data-target-id="existing-action"]')).toBeNull();
});
