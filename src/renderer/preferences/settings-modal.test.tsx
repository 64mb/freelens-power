// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./settings-modal";

vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Dialog: ({ children, className }: { children: import("react").ReactNode; className?: string }) => (
        <div className={`Dialog modal ${className ?? ""}`}>
          <div className="dialog-content">{children}</div>
        </div>
      ),
    },
  },
}));
afterEach(cleanup);

it("styles the native v2 dialog panel independently of checkbox glyphs", () => {
  const view = render(
    <SettingsModal id="example" title="Example settings" onClose={vi.fn()}>
      <label className="Checkbox">
        <i className="check-icon" />
      </label>
    </SettingsModal>,
  );
  const panel = view.container.querySelector<HTMLElement>(".Dialog > .dialog-content")!;
  const style = getComputedStyle(panel);
  expect(style.borderRadius).toBe("8px");

  expect(style.boxShadow).toContain("20px 70px");
  const matchingRules = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && panel.matches(rule.selectorText));
  expect(matchingRules.some((rule) => rule.style.background === "var(--contentColor)")).toBe(true);
  expect(getComputedStyle(view.container.querySelector(".Checkbox > .check-icon")!).borderRadius).not.toBe("8px");
});
