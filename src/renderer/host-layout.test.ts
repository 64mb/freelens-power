// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { startHostLayoutStyles } from "./host-layout";
import { powerLogsStyles } from "./power-logs.css";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  document.body.innerHTML = "";
});

it("applies modal panel and wizard corners to the native v2 wrapper and restores host styling", () => {
  document.body.innerHTML =
    '<div class="Dialog modal"><div class="dialog-content"><div class="Wizard"><div class="header"><h5>Resource</h5></div><div class="WizardStep"><div class="buttons">Create</div></div></div></div></div>';
  const panel = document.querySelector<HTMLElement>(".dialog-content")!;
  stop = startHostLayoutStyles();
  expect(getComputedStyle(panel).borderRadius).toBe("8px");

  expect(getComputedStyle(document.querySelector(".Wizard > .header")!).borderTopLeftRadius).toBe("7px");
  expect(getComputedStyle(document.querySelector(".WizardStep > .buttons")!).borderBottomLeftRadius).toBe("7px");
  stop();
  stop = undefined;
  expect(getComputedStyle(panel).borderRadius).not.toBe("8px");
});

it("bounds log confirmations using the native v2 dialog content wrapper", () => {
  document.body.innerHTML = `<style>${powerLogsStyles}</style><div class="Dialog ConfirmDialog"><div class="dialog-content"><div class="confirm-content"><div class="power-logs-confirmation">Delete capture?</div></div></div></div>`;
  const panel = document.querySelector<HTMLElement>(".Dialog > .dialog-content")!;
  expect(getComputedStyle(panel).maxWidth).toContain("640px");
  expect(getComputedStyle(panel).minWidth).toContain("360px");
});
