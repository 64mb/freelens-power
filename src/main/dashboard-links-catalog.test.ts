import { observable, runInAction } from "mobx";
import { expect, it, vi } from "vitest";

import type { DashboardSiteIcon } from "../common/dashboard-views";

const state = vi.hoisted(() => ({ store: {} }));
vi.mock("@freelensapp/extensions", () => ({
  Common: {
    Catalog: {
      WebLink: class {
        constructor(data: object) {
          Object.assign(this, data);
        }
      },
    },
  },
}));
vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => state.store },
}));

import { registerDashboardLinksCatalog } from "./dashboard-links-catalog";

it("synchronizes unique widget links, cached icons and edits in an extension-owned source", () => {
  const card = { id: "one", title: "Example", url: "https://example.com/", size: "m" };
  const store = observable({ cards: [card, { ...card, id: "two" }] });
  state.store = store;
  const icons = observable.array<DashboardSiteIcon>([]);
  const extension = { addCatalogSource: vi.fn(), removeCatalogSource: vi.fn() };
  const stop = registerDashboardLinksCatalog(extension as never, icons);
  const entities = extension.addCatalogSource.mock.calls[0][1];
  expect(entities).toHaveLength(1);
  const uid = entities[0].metadata.uid;
  expect(entities[0].metadata.source).not.toBe("local");
  expect(entities[0].spec.icon.material).toBe("public");
  runInAction(() => icons.push({ id: "one", pageUrl: card.url, dataUrl: "data:image/png;base64,AQID" }));
  expect(entities[0].spec.icon.src).toBe("data:image/png;base64,AQID");
  runInAction(() => {
    store.cards[0].title = "Updated";
  });
  expect(entities[0].metadata.name).toBe("Updated");
  expect(entities[0].metadata.uid).toBe(uid);
  runInAction(() => {
    store.cards = [{ ...card, url: "https://example.org/" }];
  });
  expect(entities).toHaveLength(1);
  expect(entities[0].spec.url).toBe("https://example.org/");
  expect(entities[0].spec.icon.src).toBeUndefined();
  runInAction(() => {
    store.cards = [];
  });
  expect(entities).toHaveLength(0);
  stop();
  expect(extension.removeCatalogSource).toHaveBeenCalledExactlyOnceWith("dashboard-links");
  runInAction(() => {
    store.cards = [card];
  });
  expect(entities).toHaveLength(0);
});
