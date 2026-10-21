// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { AiProviderIcon } from "./ai-provider-icon";

it("uses distinct bundled brand assets without adding duplicate accessible labels", () => {
  const view = render(<AiProviderIcon provider="codex" />);
  const codex = view.container.querySelector("svg");
  expect(codex?.getAttribute("fill")).toBe("currentColor");
  expect(codex?.style.color).toBe("var(--textColorPrimary)");
  expect(codex?.querySelector("path")?.getAttribute("d")).toContain("M9.205 8.658");
  expect(codex?.getAttribute("aria-hidden")).toBe("true");
  view.rerender(<AiProviderIcon provider="claude" size={20} />);
  const claude = view.container.querySelector("img");
  expect(claude?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(claude?.getAttribute("width")).toBe("20");
  expect(claude?.getAttribute("height")).toBe("20");
  view.unmount();
});
