// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const preferences = vi.hoisted(() => ({
  command: "ssh",
  replaceDefaultNodeShell: false,
  preferIPv6: false,
  useColimaSSH: true,
}));
vi.mock("../../common/store/node-shell-preferences-store", () => ({
  NodeShellPreferencesStore: { getInstanceOrCreate: () => preferences },
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Input: () => null,
      Switch: ({ checked, onChange, children }: any) => (
        <label>
          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          {children}
        </label>
      ),
    },
  },
}));

import { NodeShellPreferences } from "./node-shell-preferences";

afterEach(cleanup);

it("offers a native switch for replacing the default Node Shell action", () => {
  render(<NodeShellPreferences />);
  const toggle = screen.getByRole("checkbox", { name: "Replace default Node Shell" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  fireEvent.click(toggle);
  expect(preferences.replaceDefaultNodeShell).toBe(true);
  expect(preferences.command).toBe("ssh");
  expect(preferences.preferIPv6).toBe(false);
  expect(preferences.useColimaSSH).toBe(true);
});
