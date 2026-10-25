// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AiProviderIcon } from "./ai-provider-icon";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";

it("uses distinct bundled brand assets and native tooltips without browser titles", () => {
  const view = render(<AiProviderIcon provider="codex" />);
  const codex = view.container.querySelector("svg");
  expect(codex?.getAttribute("fill")).toBe("currentColor");
  expect(codex?.style.color).toBe("var(--textColorPrimary)");
  expect(codex?.querySelector("path")?.getAttribute("d")).toContain("M9.205 8.658");
  expect(view.getByRole("img", { name: "Codex" })).toBe(codex);
  expect(codex?.querySelector("title")).toBeNull();
  expect(tooltipText(codex)).toBe("Codex");
  view.rerender(<AiProviderIcon provider="claude" size={20} />);
  const claude = view.container.querySelector("img");
  expect(claude?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(claude?.getAttribute("width")).toBe("20");
  expect(claude?.getAttribute("height")).toBe("20");
  expect(claude?.hasAttribute("title")).toBe(false);
  expect(tooltipText(claude)).toBe("Claude");
  view.unmount();
});

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MockTooltip {...props} /> } },
}));
