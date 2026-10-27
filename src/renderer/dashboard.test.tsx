// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./dashboard";

import type { DashboardCard } from "../common/dashboard";

const mocks = vi.hoisted(() => ({
  preferences: { cards: [] as DashboardCard[], upsertCard: vi.fn() },
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Tooltip: ({ children, className }: { children: string; className: string }) => (
        <span title={children} data-tooltip-class={className} />
      ),
      Icon: ({
        material,
        tooltip,
      }: {
        material: string;
        tooltip: string | { children: string; className: string };
      }) => (
        <span
          title={typeof tooltip === "string" ? tooltip : tooltip?.children}
          data-tooltip-class={typeof tooltip === "object" ? tooltip.className : undefined}
        >
          {material}
        </span>
      ),
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
    vi.useRealTimers();
  });
  beforeEach(() => {
    mocks.preferences.cards = [];
    mocks.preferences.upsertCard.mockReset().mockImplementation((card: DashboardCard) => {
      mocks.preferences.cards = mocks.preferences.cards.map((item) => (item.id === card.id ? card : item));
    });
    mocks.on.mockClear();
    mocks.removeListener.mockClear();
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

  it("allows restarting a pending refresh after one second and ignores stale completions", async () => {
    vi.useFakeTimers();
    mocks.preferences.cards = [{ id: "site", title: "Example", url: "https://example.com", size: "m" }];
    const completions: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation((channel) =>
      channel === "freelens-power:dashboard-views:reload"
        ? new Promise((resolve) => completions.push(resolve))
        : Promise.resolve(undefined),
    );
    const view = render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await act(async () => {});
    const refresh = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    fireEvent.click(refresh);
    expect(refresh.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(refresh.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    expect(completions).toHaveLength(2);
    await act(async () => completions[0]({ failed: ["site"] }));
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => completions[1]({ failed: [] }));
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(refresh);
    expect(completions).toHaveLength(3);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => completions[2]({ failed: [] }));
  });

  it("unlocks refresh immediately when its request finishes before the cooldown", async () => {
    vi.useFakeTimers();
    mocks.preferences.cards = [{ id: "site", title: "Example", url: "https://example.com", size: "m" }];
    let complete!: (value: unknown) => void;
    mocks.invoke.mockImplementation((channel) =>
      channel === "freelens-power:dashboard-views:reload"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(undefined),
    );
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await act(async () => {});
    const refresh = screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    fireEvent.click(refresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(refresh.disabled).toBe(true);
    await act(async () => complete({ failed: [] }));
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);
    expect(refresh.disabled).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel.endsWith(":reload"))).toHaveLength(2);
  });

  it("toggles ten-second refresh independently per card without reloading immediately", () => {
    mocks.preferences.cards = [
      { id: "one", title: "First", url: "https://example.com/one", size: "s" },
      { id: "two", title: "Second", url: "https://example.com/two", size: "s" },
    ];
    const view = render(<DashboardPage onOpenPreferences={vi.fn()} />);
    const toggle = () => screen.getByRole("button", { name: "Auto-refresh First every 10 seconds" });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().querySelector("span[title]")?.getAttribute("title")).toContain("(10s)");
    for (const action of screen
      .getByRole("region", { name: "First" })
      .parentElement!.querySelectorAll("header button, header a"))
      expect(action.querySelector("span[title]")?.getAttribute("title")).toBeTruthy();
    fireEvent.click(toggle());
    view.rerender(<DashboardPage onOpenPreferences={vi.fn()} />);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().querySelector("span[title]")?.getAttribute("title")).toBe("Disable refresh");
    expect(mocks.preferences.cards[1].refreshEvery10Seconds).toBeUndefined();
    expect(mocks.invoke.mock.calls.some(([channel]) => channel.endsWith(":reload"))).toBe(false);
    fireEvent.click(toggle());
    view.rerender(<DashboardPage onOpenPreferences={vi.fn()} />);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
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

  it("shows skeletons only during actual loading and ignores obsolete card URLs", () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    const page = render(<DashboardPage onOpenPreferences={vi.fn()} />);
    const update = mocks.on.mock.calls.find(([channel]) => channel === "freelens-power:dashboard-views:loading")![1];
    expect(screen.queryByRole("status", { name: "Loading Tool" })).toBeNull();
    act(() => update({}, { id: "card", url: "https://obsolete.example/", loading: true, failed: false }));
    expect(screen.queryByRole("status", { name: "Loading Tool" })).toBeNull();
    act(() => update({}, { id: "card", url: "https://example.com/", loading: true, failed: false }));
    expect(screen.getByRole("status", { name: "Loading Tool" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tool" }).getAttribute("aria-busy")).toBe("true");
    act(() => update({}, { id: "card", url: "https://example.com/", loading: false, failed: false }));
    expect(screen.queryByRole("status", { name: "Loading Tool" })).toBeNull();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    expect(screen.queryByRole("status", { name: "Loading Tool" })).toBeNull();
    act(() => update({}, { id: "card", url: "https://example.com/", loading: true, failed: false }));
    expect(screen.getByRole("status", { name: "Loading Tool" })).toBeTruthy();
    act(() => update({}, { id: "card", url: "https://example.com/", loading: false, failed: true }));
    expect(screen.queryByRole("status", { name: "Loading Tool" })).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    page.unmount();
    expect(mocks.removeListener).toHaveBeenCalledWith("freelens-power:dashboard-views:loading", update);
  });

  it("renders each size with a native viewport placeholder and an external link", () => {
    mocks.preferences.cards = (["xs", "s", "m", "l", "xl"] as const).map((size) => ({
      id: size,
      title: `Tool ${size}`,
      url: `https://example.com/${size}`,
      size,
    }));
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    for (const size of ["xs", "s", "m", "l", "xl"]) {
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

  it("clips native views to the host scroll area and updates after ancestor scrolling", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    const page = render(
      <div style={{ overflowX: "auto", overflowY: "auto" }} data-testid="host-main">
        <DashboardPage onOpenPreferences={vi.fn()} />
      </div>,
    );
    const host = screen.getByTestId("host-main");
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 220 },
    });
    fireEvent.scroll(host);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:sync", {
        cards: [
          {
            id: "card",
            bounds: { x: 0, y: 0, width: 300, height: 300 },
            clip: { x: 0, y: 0, width: 300, height: 220 },
          },
        ],
      }),
    );
    mocks.invoke.mockClear();
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 0 });
    fireEvent.scroll(host);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:sync", { cards: [] }),
    );
    page.unmount();
  });

  it("resyncs native visibility when returning to the application", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    mocks.invoke.mockClear();
    fireEvent.focus(window);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "freelens-power:dashboard-views:sync",
        expect.objectContaining({ cards: expect.any(Array) }),
      ),
    );
    mocks.invoke.mockClear();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "freelens-power:dashboard-views:sync",
        expect.objectContaining({ cards: expect.any(Array) }),
      ),
    );
  });

  it("adapts column counts and card spans to the available dashboard width", async () => {
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    const dashboard = document.querySelector("main")!;
    for (const [width, columns] of [
      [1199, 4],
      [1200, 6],
      [799, 2],
      [800, 4],
      [519, 1],
      [520, 2],
      [1800, 6],
    ]) {
      Object.defineProperty(dashboard, "clientWidth", { configurable: true, value: width + 56 });
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(dashboard.style.getPropertyValue("--power-columns")).toBe(String(columns)));
      expect(dashboard.style.getPropertyValue("--power-small-span")).toBe(String(Math.min(2, columns)));
      expect(dashboard.style.getPropertyValue("--power-medium-span")).toBe(String(Math.min(4, columns)));
      expect(dashboard.style.getPropertyValue("--power-large-span")).toBe(String(Math.min(4, columns)));
    }
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
      expect(mocks.invoke).toHaveBeenCalledWith(
        "freelens-power:dashboard-views:sync",
        expect.objectContaining({ cards: [], hidden: true }),
      ),
    );
    mocks.invoke.mockClear();
    dialog.remove();
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([, payload]) => payload?.cards?.length === 1)).toBe(true));
  });
  it("keeps website views visible through native tooltips and focus changes without reloading", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    mocks.invoke.mockClear();
    const tooltip = document.createElement("div");
    tooltip.className = "Tooltip visible";
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);
    try {
      fireEvent(window, new Event("blur"));
      fireEvent(window, new Event("focus"));
      await waitFor(() =>
        expect(mocks.invoke.mock.calls.some(([, payload]) => payload?.cards?.length === 1)).toBe(true),
      );
      expect(mocks.invoke).not.toHaveBeenCalledWith(
        "freelens-power:dashboard-views:sync",
        expect.objectContaining({ hidden: true }),
      );
      expect(mocks.invoke).not.toHaveBeenCalledWith("freelens-power:dashboard-views:clear");
      expect(mocks.invoke).not.toHaveBeenCalledWith("freelens-power:dashboard-views:reload", expect.anything());
    } finally {
      tooltip.remove();
    }
  });
  it("preserves pre-layout scroll despite expansion clamping and restores stable cached viewports without reload", async () => {
    mocks.preferences.cards = ["first", "second"].map((id) => ({
      id,
      title: id,
      url: `https://example.com/${id}`,
      size: "s",
    }));
    const page = render(<DashboardPage onOpenPreferences={vi.fn()} />);
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([, payload]) => payload?.cards?.length === 2)).toBe(true));
    const first = screen.getByRole("region", { name: "first" });
    const second = screen.getByRole("region", { name: "second" });
    const root = document.querySelector("main")!;
    vi.spyOn(first, "getBoundingClientRect").mockImplementation(() => {
      const size = root.classList.contains("power-dashboard-expanded") ? 280 : 180;
      return { x: 0, y: 0, left: 0, top: 0, right: size, bottom: size, width: size, height: size, toJSON() {} };
    });
    let scrollTop = 100;
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get() {
        if (root.classList.contains("power-dashboard-expanded")) scrollTop = 0;
        return scrollTop;
      },
      set(value: number) {
        scrollTop = value;
      },
    });
    root.scrollTop = 100;
    mocks.invoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Expand first" }));
    expect(root.classList.contains("power-dashboard-expanded")).toBe(true);
    expect(root.scrollTop).toBe(0);
    expect(second.parentElement?.hidden).toBe(true);
    expect(screen.getByRole("region", { name: "first" })).toBe(first);
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(
          ([, payload]) =>
            payload?.cards?.length === 1 &&
            payload.cards[0].id === "first" &&
            payload.cards[0].bounds.width === 280 &&
            payload.cards[0].scrollbars === true,
        ),
      ).toBe(true),
    );
    expect(mocks.invoke.mock.calls.every(([channel]) => channel === "freelens-power:dashboard-views:sync")).toBe(true);
    expect(screen.getByRole("button", { name: "Restore first" }).getAttribute("aria-pressed")).toBe("true");
    mocks.invoke.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(root.classList.contains("power-dashboard-expanded")).toBe(false);
    expect(root.scrollTop).toBe(100);
    expect(second.parentElement?.hidden).toBe(false);
    expect(screen.getByRole("region", { name: "first" })).toBe(first);
    await waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(
          ([, payload]) =>
            payload?.cards?.length === 2 && payload.cards.every((card: { scrollbars?: boolean }) => !card.scrollbars),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand second" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore second" }));
    expect(second.parentElement?.hidden).toBe(false);
    page.unmount();
    expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:clear");
  });
  it("restores expansion when Escape is forwarded from the focused native website", async () => {
    mocks.preferences.cards = [{ id: "card", title: "Tool", url: "https://example.com", size: "s" }];
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Tool" }));
    const restore = mocks.on.mock.calls
      .filter(([channel]) => channel === "freelens-power:dashboard-escape")
      .at(-1)?.[1];
    expect(restore).toBeTypeOf("function");
    act(() => restore());
    expect(screen.getByRole("button", { name: "Expand Tool" })).toBeTruthy();
  });
  it("dims a pinned card, focuses its duplicate and restores it when the window closes", async () => {
    mocks.preferences.cards = [{ id: "site", title: "Example", url: "https://example.com", size: "m" }];
    mocks.invoke.mockImplementation(async (channel, payload) =>
      channel === "freelens-power:dashboard-views:pin" && payload?.pinned === true ? { pinned: ["site"] } : undefined,
    );
    render(<DashboardPage onOpenPreferences={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pin Example" }).querySelector(".Icon.material .icon")?.textContent).toBe(
      "push_pin",
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin Example" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin Example" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Unpin Example" }).querySelector("svg path")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Example" }).parentElement?.classList.contains("power-dashboard-card-pinned"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Focus pinned Example" }));
    expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:dashboard-views:pin", { id: "site", focus: true });
    const listener = mocks.on.mock.calls
      .filter(([channel]) => channel === "freelens-power:dashboard-views:pinned")
      .at(-1)?.[1];
    act(() => listener?.({}, []));
    expect(screen.getByRole("button", { name: "Pin Example" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Focus pinned Example" })).toBeNull();
  });
});
