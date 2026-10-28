// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { observable } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ preferences: undefined as any }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Switch: (props: any) => (
        <label>
          <input
            type="checkbox"
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.target.checked)}
          />
          {props.children}
        </label>
      ),
    },
  },
}));
vi.mock("../../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));

import { PowerPreferencesToggle } from "./power-preferences";

afterEach(cleanup);
it("keeps update checks below the master switch and preserves opt-out when Power is disabled and reenabled", () => {
  mocks.preferences = observable({ enabled: true, checkUpdates: true });
  const view = render(<PowerPreferencesToggle />);
  const master = screen.getByLabelText("Enable Freelens Power") as HTMLInputElement;
  const updates = screen.getByLabelText("Check for extension updates") as HTMLInputElement;
  expect(master.compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(view.container.querySelector("nav")).toBeNull();
  expect(updates.checked).toBe(true);
  fireEvent.click(updates);
  expect(mocks.preferences.checkUpdates).toBe(false);
  fireEvent.click(master);
  expect(updates.disabled).toBe(true);
  fireEvent.click(master);
  expect(updates.disabled).toBe(false);
  expect(updates.checked).toBe(false);
});
