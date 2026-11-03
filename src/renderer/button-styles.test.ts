// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { startPowerButtonStyles } from "./button-styles";

afterEach(() => document.head.replaceChildren());

it("styles native Create and Remove controls only while resource customization is enabled", () => {
  let stop = startPowerButtonStyles();
  expect(document.head.textContent).toContain(".AddRemoveButtons .Button:is(.remove-button, .add-button)");
  stop();
  stop = startPowerButtonStyles(false);
  expect(document.head.textContent).not.toContain(".AddRemoveButtons");
  expect(document.head.textContent).toContain(".power-ai-launcher");
  stop();
  expect(document.querySelector('[data-freelens-power="button-styles"]')).toBeNull();
});
