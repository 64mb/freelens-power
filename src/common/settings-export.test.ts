import { expect, it } from "vitest";
import { createSettingsExport, parseSettingsImport } from "./settings-export";

it("preserves the per-card ten-second refresh setting through backup and restore", () => {
  const backup = createSettingsExport(
    [{ id: "live", title: "Live", url: "https://example.com", size: "s", refreshEvery10Seconds: true }],
    [],
  );
  expect(parseSettingsImport(JSON.parse(JSON.stringify(backup))).dashboard.cards[0].refreshEvery10Seconds).toBe(true);
});

it("exports only validated dashboard cards and shortcut fields", () => {
  const data = createSettingsExport(
    [
      {
        id: "card",
        title: "Example",
        url: "https://example.com",
        size: "s",
        autoRefresh: true,
        selector: " main ",
        auth: "excluded",
        conversations: ["excluded"],
      },
      { url: "javascript:alert(1)" },
    ],
    [
      {
        id: "shortcut",
        label: "Health",
        command: "health",
        prompt: "Inspect resource health",
        provider: "excluded",
        systemPrompt: "excluded",
        conversations: ["excluded"],
      },
    ],
  );
  expect(data).toEqual({
    format: "freelens-power-settings",
    version: 1,
    dashboard: {
      cards: [
        { id: "card", title: "Example", url: "https://example.com/", size: "s", autoRefresh: true, selector: "main" },
      ],
    },
    ai: { shortcuts: [{ id: "shortcut", label: "Health", command: "health", prompt: "Inspect resource health" }] },
  });
  expect(JSON.stringify(data)).not.toContain("excluded");
  expect(createSettingsExport(null, null).dashboard.cards).toEqual([]);
});

it("removes URL credentials from copies while preserving benign queries and SPA routes", () => {
  const cards = [
    {
      id: "card",
      title: "Example",
      url: "https://user:pass@example.com/chart?view=cpu&ACCESS_TOKEN=hidden-token&api_key=hidden-key&Password=hidden-password&client_secret=hidden-secret&credential=hidden-credential&session=hidden-session&Authorization=hidden-auth&X-Amz-Signature=hidden-signature&sig=hidden-sas#access_token=hidden-fragment",
      size: "m",
    },
  ];
  const original = JSON.stringify(cards);
  const data = createSettingsExport(cards, []);
  expect(data.dashboard.cards[0].url).toBe("https://example.com/chart?view=cpu");
  expect(JSON.stringify(data)).not.toContain("hidden-");
  expect(JSON.stringify(cards)).toBe(original);
  expect(
    createSettingsExport([{ url: "https://example.com/?view=cpu#/charts?range=day" }], []).dashboard.cards[0].url,
  ).toBe("https://example.com/?view=cpu#/charts?range=day");
  expect(
    createSettingsExport([{ url: "https://example.com/#/charts?code=hidden-code&view=cpu" }], []).dashboard.cards[0]
      .url,
  ).toBe("https://example.com/");
});
it("does not leak credentials through generated legacy card IDs", () => {
  const data = createSettingsExport([{ url: "https://user:pass@example.com/?token=hidden-token" }], []);
  expect(data.dashboard.cards[0].url).toBe("https://example.com/");
  expect(data.dashboard.cards[0].id).toBe("export-card-1");
  expect(JSON.stringify(data)).not.toContain("hidden-token");
  expect(JSON.stringify(data)).not.toContain("user");
});

it("removes old credential-bearing generated IDs after a card URL was edited", () => {
  const data = createSettingsExport(
    [
      {
        id: `card-${encodeURIComponent("https://user:pass@example.com/?token=old-secret")}`,
        url: "https://example.com/new",
      },
    ],
    [],
  );
  expect(data.dashboard.cards[0]).toMatchObject({ id: "export-card-1", url: "https://example.com/new" });
  expect(JSON.stringify(data)).not.toMatch(/old-secret|user|pass/);
});

function importFixture() {
  return {
    format: "freelens-power-settings",
    version: 1,
    dashboard: {
      cards: [{ id: "card", title: "Chart", url: "https://example.com/chart", size: "m", selector: "main" }],
    },
    ai: {
      shortcuts: [{ id: "shortcut", label: "Inspect", command: "inspect", prompt: "Inspect the selected resource" }],
    },
  };
}

it("imports only supported lists and strips unrelated settings and credentials", () => {
  const value = importFixture();
  const result = parseSettingsImport({
    ...value,
    readOnly: false,
    auth: "excluded",
    history: ["excluded"],
    ai: { ...value.ai, token: "excluded", conversations: ["excluded"] },
  });
  expect(result).toEqual(createSettingsExport(value.dashboard.cards, value.ai.shortcuts));
  expect(JSON.stringify(result)).not.toMatch(/excluded|readOnly|conversations|history|token/);
  expect(parseSettingsImport({ ...value, dashboard: { cards: [] }, ai: { shortcuts: [] } }).dashboard.cards).toEqual(
    [],
  );
});

it("rejects incompatible or malformed backups instead of silently dropping entries", () => {
  const valid = importFixture();
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...valid, format: "other" },
    { ...valid, version: 2 },
    { ...valid, dashboard: {} },
    { ...valid, ai: {} },
    { ...valid, dashboard: { cards: Array(201).fill(valid.dashboard.cards[0]) } },
    { ...valid, ai: { shortcuts: Array(201).fill(valid.ai.shortcuts[0]) } },
  ];
  for (const patch of [
    { url: "javascript:alert(1)" },
    { url: "file:///private/example" },
    { url: "invalid" },
    { size: "xxl" },
    { id: "" },
    { title: "" },
    { selector: "x".repeat(513) },
    { selector: "a\u0000b" },
    { autoRefresh: "true" },
    { refreshEvery10Seconds: "true" },
  ])
    invalid.push({ ...valid, dashboard: { cards: [{ ...valid.dashboard.cards[0], ...patch }] } });
  invalid.push({ ...valid, dashboard: { cards: [valid.dashboard.cards[0], valid.dashboard.cards[0]] } });
  invalid.push({ ...valid, ai: { shortcuts: [{ ...valid.ai.shortcuts[0], command: "unsafe command" }] } });
  invalid.push({ ...valid, ai: { shortcuts: [{ ...valid.ai.shortcuts[0], prompt: "" }] } });
  for (const value of invalid) expect(() => parseSettingsImport(value)).toThrow("Invalid settings backup");
});

it("round-trips valid cards beyond old import-only field and list limits", () => {
  const cards = Array.from({ length: 201 }, (_, index) => ({
    id: `${index}-${"i".repeat(513)}`,
    title: "Example title ".repeat(20),
    url: `https://example.com/${index}?path=${"x".repeat(8193)}`,
    size: "m",
  }));
  const longCard = createSettingsExport(cards.slice(0, 1), []);
  expect(parseSettingsImport(longCard)).toEqual(longCard);
  const list = createSettingsExport(
    cards.map((card) => ({ ...card, url: "https://example.com" })),
    [],
  );
  expect(parseSettingsImport(list)).toEqual(list);
});

it("rejects an oversized export before it can become an unrestorable backup", () => {
  expect(() =>
    createSettingsExport([{ id: "card", title: "x".repeat(1024 * 1024), url: "https://example.com", size: "m" }], []),
  ).toThrow("Settings backup is too large");
});

it("round-trips all dashboard sizes without remapping persisted size keys", () => {
  const sizes = ["xs", "s", "m", "l", "xl"];
  const cards = sizes.map((size) => ({ id: size, title: size, url: `https://example.com/${size}`, size }));
  const exported = createSettingsExport(cards, []);
  expect(exported.dashboard.cards.map((card) => card.size)).toEqual(sizes);
  expect(parseSettingsImport(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
});
