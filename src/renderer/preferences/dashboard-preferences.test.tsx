// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPreferences } from "./dashboard-preferences";

import type { ReactNode } from "react";

import type { DashboardCard } from "../../common/dashboard";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue([]),
  on: vi.fn(),
  removeListener: vi.fn(),
  preferences: {
    cards: [{ id: "example", title: "Example", url: "https://example.com/", size: "m" }] as DashboardCard[],
    upsertCard: vi.fn(),
    removeCard: vi.fn(),
    moveCard: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));
vi.mock("../../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Icon: () => <span aria-hidden="true" />,
      Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Button: ({
        label,
        onClick,
        "aria-label": ariaLabel,
      }: {
        label: string;
        onClick: () => void;
        "aria-label"?: string;
      }) => (
        <button type="button" aria-label={ariaLabel} onClick={onClick}>
          {label}
        </button>
      ),
      Input: ({ onChange, ...props }: { onChange: (value: string) => void }) => (
        <input {...props} onChange={(event) => onChange(event.target.value)} />
      ),
      Checkbox: ({ value, onChange, id }: { id: string; value: boolean; onChange: (checked: boolean) => void }) => (
        <label>
          <input id={id} type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
        </label>
      ),
      Select: () => <select aria-label="Card size" />,
    },
  },
}));

describe("dashboard preferences", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue([]);
    mocks.preferences.cards = [{ id: "example", title: "Example", url: "https://example.com/", size: "m" }];
  });

  it("keeps picker results in the editor draft and preserves existing selectors after cancel", async () => {
    mocks.preferences.cards[0].selector = "main";
    mocks.invoke.mockImplementation(async (channel: string) =>
      channel === "freelens-power:dashboard:pick-element" ? { status: "selected", selector: "#chart" } : [],
    );
    render(<DashboardPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Draft title" } });
    fireEvent.click(screen.getByRole("button", { name: "Pick element on website" }));
    await waitFor(() =>
      expect((screen.getByLabelText("CSS selector (optional)") as HTMLInputElement).value).toBe("#chart"),
    );
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Draft title");
    mocks.invoke.mockImplementation(async () => ({ status: "canceled" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick element on website" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pick element on website" })).toBeTruthy());
    expect((screen.getByLabelText("CSS selector (optional)") as HTMLInputElement).value).toBe("#chart");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
  });

  it("keeps compact rows and discards a canceled or escaped draft", () => {
    render(<DashboardPreferences />);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Example");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
  });

  it("validates URLs and saves only a valid explicit draft", () => {
    render(<DashboardPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save card" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save card" }));
    expect(mocks.preferences.upsertCard).toHaveBeenCalledWith({
      id: "example",
      title: "Example",
      url: "https://example.com/new",
      size: "m",
      autoRefresh: false,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("reorders only from the drag handle and supports arrow keys", () => {
    mocks.preferences.cards.push({ id: "second", title: "Second", url: "https://example.com/second", size: "m" });
    render(<DashboardPreferences />);
    const handle = screen.getByRole("button", { name: "Reorder Example" });
    const target = screen.getByRole("button", { name: "Reorder Second" }).parentElement as HTMLElement;
    expect(handle.draggable).toBe(true);
    expect(target.draggable).toBe(false);
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(mocks.preferences.moveCard).not.toHaveBeenCalled();
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.style.boxShadow).toContain("2px");
    fireEvent.drop(target, { dataTransfer });
    expect(mocks.preferences.moveCard).toHaveBeenLastCalledWith("example", 1);
    expect(target.style.boxShadow).toBe("");
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(mocks.preferences.moveCard).toHaveBeenLastCalledWith("example", 1);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Second" }), { key: "ArrowUp" });
    expect(mocks.preferences.moveCard).toHaveBeenLastCalledWith("second", 0);
  });
  it("keeps refresh changes as a draft and preserves them only on save", () => {
    render(<DashboardPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    const toggle = screen.getByRole("checkbox", { name: "Autorefresh" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save card" }));
    expect(mocks.preferences.upsertCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: "example", autoRefresh: true }),
    );
  });

  it("preserves existing automatic refresh when editing other fields", () => {
    mocks.preferences.cards[0].autoRefresh = true;
    render(<DashboardPreferences />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save card" }));
    expect(mocks.preferences.upsertCard).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Changed", autoRefresh: true }),
    );
  });
});

it("uses the discovered icon after a failed root favicon and ignores icons for old URLs", async () => {
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue([
    { id: "example", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" },
  ]);
  const { container } = render(<DashboardPreferences />);
  fireEvent.error(container.querySelector("img")!);
  await waitFor(() => expect(container.querySelector("img")?.src).toBe("data:image/png;base64,AQID"));
  cleanup();
  mocks.invoke.mockResolvedValue([
    { id: "example", pageUrl: "https://example.org/", dataUrl: "data:image/png;base64,AQID" },
  ]);
  const next = render(<DashboardPreferences />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(next.container.querySelector("img")?.src).toBe("https://example.com/favicon.ico");
  cleanup();
});

it("enables automatic refresh for new cards and aligns its native checkbox with the other controls", () => {
  render(<DashboardPreferences />);
  fireEvent.click(screen.getByRole("button", { name: "Add card" }));
  const checkbox = screen.getByRole("checkbox", { name: "Autorefresh" }) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  expect(checkbox.closest(".power-settings-row")?.querySelector("label")?.textContent).toBe("Autorefresh");
  expect(checkbox.parentElement?.parentElement?.style.width).toBe("340px");
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.org" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Add card" })[0]);
  expect(mocks.preferences.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ autoRefresh: true }));
  cleanup();
});

it("refreshes discovered icons when the main process announces a cache update", async () => {
  mocks.invoke.mockResolvedValueOnce([]);
  const view = render(<DashboardPreferences />);
  await waitFor(() => expect(mocks.on).toHaveBeenCalled());
  mocks.invoke.mockResolvedValue([
    { id: "example", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" },
  ]);
  const listener = mocks.on.mock.calls.at(-1)?.[1];
  listener();
  await waitFor(() => expect(view.container.querySelector("img")?.src).toBe("data:image/png;base64,AQID"));
});

it("edits and clears selector drafts only when saved", () => {
  cleanup();
  mocks.preferences.cards = [
    { id: "example", title: "Example", url: "https://example.com/", size: "m", selector: "#chart" },
  ];
  vi.clearAllMocks();
  render(<DashboardPreferences />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
  expect((screen.getByLabelText("CSS selector (optional)") as HTMLInputElement).value).toBe("#chart");
  fireEvent.click(screen.getByRole("button", { name: "Clear selector" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit Example" }));
  fireEvent.change(screen.getByLabelText("CSS selector (optional)"), { target: { value: "x".repeat(513) } });
  fireEvent.click(screen.getByRole("button", { name: "Save card" }));
  expect(mocks.preferences.upsertCard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear selector" }));
  fireEvent.click(screen.getByRole("button", { name: "Save card" }));
  expect(mocks.preferences.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ selector: undefined }));
  cleanup();
});
