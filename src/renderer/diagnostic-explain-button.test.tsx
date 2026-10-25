// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticExplainButton } from "./diagnostic-explain-button";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";

const state = vi.hoisted(() => ({ preferences: { enabled: false } }));
vi.mock("../common/store/ai-preferences-store", async () => {
  const { observable } = await import("mobx");
  state.preferences = observable({ enabled: false });
  return { AiPreferencesStore: { getInstanceOrCreate: () => state.preferences } };
});
afterEach(cleanup);
it("explains why AI is disabled and reacts to enabling it in preferences", async () => {
  const { runInAction } = await import("mobx");
  const onClick = vi.fn();
  const view = render(
    <DiagnosticExplainButton title="Explain with AI" onClick={onClick}>
      Explain with AI
    </DiagnosticExplainButton>,
  );
  const button = view.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(tooltipText(button)).toBe("Enable AI in Power settings to explain this finding");
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  act(() =>
    runInAction(() => {
      state.preferences.enabled = true;
    }),
  );
  expect(button.disabled).toBe(false);
  expect(tooltipText(button)).toBe("Explain with AI");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
});

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MockTooltip {...props} /> } },
}));
