// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiStarterPrompts } from "../ai-shortcuts";
import { AiShortcutsPreferences } from "./ai-shortcuts-preferences";

import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  preferences: {
    shortcuts: [{ id: "health", label: "Health", command: "health", prompt: "Inspect health" }],
    upsertShortcut: vi.fn(() => true),
    removeShortcut: vi.fn(),
  },
}));
vi.mock("../../common/store/ai-shortcuts-store", () => ({
  AiShortcutsStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Icon: () => <span />,
      Button: ({
        label,
        children,
        primary: _primary,
        ...props
      }: {
        label?: string;
        children?: ReactNode;
        primary?: boolean;
      }) => (
        <button {...props}>
          {label}
          {children}
        </button>
      ),
      Input: ({ onChange, ...props }: { onChange: (value: string) => void }) => (
        <input {...props} onChange={(event) => onChange(event.target.value)} />
      ),
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AI shortcut controls", () => {
  it("launches the prompt with one click and respects disabled state", () => {
    const onSelect = vi.fn();
    const view = render(<AiStarterPrompts onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Health"));
    expect(onSelect).toHaveBeenCalledWith("Inspect health");
    view.rerender(<AiStarterPrompts onSelect={onSelect} disabled />);
    fireEvent.click(screen.getByText("Health"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("keeps shortcut drafts in the shared modal and discards them on cancel or Escape", () => {
    render(<AiShortcutsPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Health" }));
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe("power-ai-shortcut-editor-heading");
    fireEvent.change(screen.getByLabelText("Shortcut label"), { target: { value: "Unsaved label" } });
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.preferences.upsertShortcut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Health" }));
    expect((screen.getByLabelText("Shortcut label") as HTMLInputElement).value).toBe("Health");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("edits a stable shortcut and reports validation failures", () => {
    mocks.preferences.upsertShortcut.mockReturnValueOnce(false);
    render(<AiShortcutsPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Health" }));
    fireEvent.change(screen.getByLabelText("Shortcut label"), { target: { value: "Cluster health" } });
    fireEvent.click(screen.getByText("Save shortcut"));
    expect(screen.getByRole("alert").textContent).toContain("unique command");
    expect(mocks.preferences.upsertShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: "health", label: "Cluster health" }),
    );
    fireEvent.click(screen.getByText("Save shortcut"));
    expect(screen.queryByLabelText("Shortcut prompt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Health" }));
    expect(mocks.preferences.removeShortcut).toHaveBeenCalledWith("health");
  });
});
