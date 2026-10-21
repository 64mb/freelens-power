// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./dashboard";

import type { DashboardCard } from "../common/dashboard";

const mocks = vi.hoisted(() => ({
  preferences: { cards: [] as DashboardCard[] },
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Icon: ({ material, tooltip }: { material: string; tooltip: string }) => <span title={tooltip}>{material}</span>,
    },
  },
}));

vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  shell: { openExternal: mocks.openExternal },
}));

vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));

describe("DashboardPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    mocks.preferences.cards = [];
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 300,
      width: 300,
      height: 300,
      toJSON() {},
    });
  });

  it("opens preferences from the header and empty state", () => {
    const onOpenPreferences = vi.fn();
    render(<DashboardPage onOpenPreferences={onOpenPreferences} />);
    expect(screen.getByRole("heading", { name: "Build your dashboard" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Add cards" }));
    expect(onOpenPreferences).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("renders each size with a native viewport placeholder and an external link", () => {
    mocks.preferences.cards = (["s", "m", "l"] as const).map((size) => ({
      id: size,
      title: `Tool ${size}`,
      url: `https://example.com/${size}`,
      size,
    }));
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    for (const size of ["s", "m", "l"]) {
      const frame = screen.getByRole("region", { name: `Tool ${size}` });
      expect(frame.parentElement?.classList.contains(`power-dashboard-card-${size}`)).toBe(true);
      const link = screen.getByRole("link", { name: `Open Tool ${size} in browser` });
      expect(link.getAttribute("href")).toBe(`https://example.com/${size}`);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    fireEvent.click(screen.getByRole("link", { name: "Open Tool s in browser" }));
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/s");
  });

  it("omits unsafe URLs even when they appear in stored cards", () => {
    mocks.preferences.cards = [
      { id: "bad", title: "Unsafe", url: "javascript:alert(1)", size: "s" },
      { id: "good", title: "Safe", url: "https://example.com", size: "m" },
    ];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    expect(document.querySelectorAll(".power-dashboard-embed")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Unsafe" })).toBeNull();
    expect(screen.getByRole("region", { name: "Safe" })).toBeTruthy();
  });
  it("syncs only visible geometry without URLs and clears native views on unmount", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    const page = render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:sync", {
        cards: [
          {
            id: "card",
            bounds: { x: 0, y: 0, width: 300, height: 300 },
            clip: { x: 0, y: 0, width: 300, height: 300 },
          },
        ],
      }),
    );
    page.unmount();
    expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:clear");
  });

  it("updates clipping on scroll and omits offscreen cards", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    mocks.invoke.mockClear();
    vi.spyOn(screen.getByRole("region", { name: "Tool" }), "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -400,
      left: 0,
      top: -400,
      right: 300,
      bottom: -100,
      width: 300,
      height: 300,
      toJSON() {},
    });
    fireEvent.scroll(document.querySelector("main")!);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:sync", { cards: [] }),
    );
  });

  it("adapts column counts and card spans to the available dashboard width", async () => {
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    const dashboard = document.querySelector("main")!;
    Object.defineProperty(dashboard, "clientWidth", { configurable: true, value: 1976 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(dashboard.style.getPropertyValue("--power-columns")).toBe("7"));
    expect(dashboard.style.getPropertyValue("--power-large-span")).toBe("4");
    Object.defineProperty(dashboard, "clientWidth", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(dashboard.style.getPropertyValue("--power-columns")).toBe("1"));
    expect(dashboard.style.getPropertyValue("--power-medium-span")).toBe("1");
    expect(dashboard.style.getPropertyValue("--power-large-span")).toBe("1");
  });

  it("shows an actionable error when native view synchronization fails", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    mocks.invoke.mockRejectedValue(new Error("private diagnostic"));
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Unable to load dashboard cards. Open them in your browser.",
    );
  });
  it("hides website views while a host dialog is open and restores them", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    mocks.invoke.mockClear();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:sync", { cards: [], hidden: true }),
    );
    mocks.invoke.mockClear();
    dialog.remove();
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([, payload]) => payload?.cards?.length === 1)).toBe(true));
  });
});
