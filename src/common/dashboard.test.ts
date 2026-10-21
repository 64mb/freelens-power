import { describe, expect, it, vi } from "vitest";
import { DashboardPreferencesStore } from "./store/dashboard-preferences-store";

vi.mock("@freelensapp/extensions", () => ({
  Common: {
    Store: {
      ExtensionStore: class {
        constructor(_options: unknown) {}
      },
    },
  },
}));

import { normalizeDashboardUrl, sanitizeDashboardCards } from "./dashboard";

describe("dashboard URLs", () => {
  it("normalizes HTTP and HTTPS URLs while preserving paths and query parameters", () => {
    expect(normalizeDashboardUrl(" https://EXAMPLE.com/metrics?q=cpu#chart ")).toBe(
      "https://example.com/metrics?q=cpu#chart",
    );
    expect(normalizeDashboardUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });

  it.each([
    "",
    "example.com",
    "/relative",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "ftp://example.com",
    "https://",
    "https://bad host",
  ])("rejects unsafe or invalid URL %s", (url) => {
    expect(normalizeDashboardUrl(url)).toBeUndefined();
  });
});

describe("dashboard persisted cards", () => {
  it("ignores corrupt records and supplies usable defaults", () => {
    expect(
      sanitizeDashboardCards([
        null,
        {},
        { url: "javascript:alert(1)" },
        { id: "one", title: " ", url: "https://example.com", size: "bad" },
      ]),
    ).toEqual([{ id: "one", title: "example.com", url: "https://example.com/", size: "m", autoRefresh: false }]);
    expect(sanitizeDashboardCards(undefined)).toEqual([]);
  });

  it("retains valid preferences and creates unique deterministic IDs for legacy and duplicate records", () => {
    const input = [
      { id: "one", title: " Metrics ", url: "https://example.com/metrics", size: "l", unknown: "discard" },
      { id: "one", title: "Other", url: "http://localhost:8080", size: "s" },
      { url: "https://example.com" },
      { url: "https://example.com" },
    ];
    const cards = sanitizeDashboardCards(input);
    expect(cards).toEqual(sanitizeDashboardCards(input));
    expect(new Set(cards.map((card) => card.id)).size).toBe(4);
    expect(cards[0]).toEqual({
      id: "one",
      title: "Metrics",
      url: "https://example.com/metrics",
      size: "l",
      autoRefresh: false,
    });
    expect(sanitizeDashboardCards(cards)).toEqual(cards);
  });
});

describe("dashboard preferences store", () => {
  it("updates and removes cards and returns isolated plain snapshots", () => {
    const store = new DashboardPreferencesStore();
    store.fromStore({ cards: [{ id: "one", title: "Metrics", url: "https://example.com", size: "s" }] });
    const snapshot = store.toJSON();
    snapshot.cards[0].title = "Changed outside the store";
    expect(store.cards[0].title).toBe("Metrics");
    store.upsertCard({ id: "one", title: "Updated", url: "https://example.com/updated", size: "l" });
    expect(store.cards).toHaveLength(1);
    expect(store.toJSON().cards[0].size).toBe("l");
    store.upsertCard({ id: "two", title: "Invalid", url: "javascript:alert(1)", size: "m" });
    expect(store.cards).toHaveLength(1);
    store.removeCard("one");
    expect(store.toJSON()).toEqual({ cards: [] });
  });
});

describe("dashboard card ordering", () => {
  it("persists reordered cards without changing their settings", () => {
    const store = new DashboardPreferencesStore();
    const cards = ["first", "second", "third"].map((id) => ({
      id,
      title: id,
      url: `https://example.com/${id}`,
      size: "m" as const,
      autoRefresh: false,
    }));
    store.fromStore({ cards });
    store.moveCard("first", 2);
    expect(store.toJSON().cards).toEqual([cards[1], cards[2], cards[0]]);
    const restored = new DashboardPreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.toJSON()).toEqual(store.toJSON());
    restored.moveCard("first", -1);
    expect(restored.toJSON().cards).toEqual(cards);
    restored.moveCard("missing", 1);
    restored.moveCard("first", Number.NaN);
    expect(restored.toJSON().cards).toEqual(cards);
  });
});

describe("dashboard automatic refresh preferences", () => {
  it("enables refresh only for the boolean true and defaults legacy records to false", () => {
    for (const autoRefresh of [undefined, false, "true", 1, null]) {
      expect(sanitizeDashboardCards([{ url: "https://example.com", autoRefresh }])[0].autoRefresh).toBe(false);
    }
    expect(sanitizeDashboardCards([{ url: "https://example.com", autoRefresh: true }])[0].autoRefresh).toBe(true);
  });

  it("persists refresh metadata through edits, reordering and reload", () => {
    const store = new DashboardPreferencesStore();
    store.fromStore({
      cards: [{ id: "one", title: "Example", url: "https://example.com", size: "m", autoRefresh: true }],
    });
    store.upsertCard({ ...store.cards[0], title: "Updated" });
    store.upsertCard({ id: "two", title: "Other", url: "https://example.com/other", size: "s" });
    store.moveCard("one", 1);
    const restored = new DashboardPreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.cards.map((card) => [card.id, card.autoRefresh])).toEqual([
      ["two", false],
      ["one", true],
    ]);
  });
});
