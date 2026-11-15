// @vitest-environment jsdom
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { startReadOnlyMode } from "./read-only";

const catalog = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Catalog: { catalogEntities: { getById: (id: string) => catalog.get(id) } } },
  Common: {
    Catalog: { WebLink: { apiVersion: "entity.k8slens.dev/v1alpha1", kind: "WebLink" } },
    Store: {
      ExtensionStore: class {
        static instance: unknown;
        static getInstanceOrCreate() {
          return (this.instance ??= new this());
        }
      },
    },
  },
}));

describe("read-only interface", () => {
  let dispose: (() => void) | undefined;
  let preferences: ReadOnlyPreferencesStore;
  const hidden = (id: string) => document.getElementById(id)?.hasAttribute("data-freelens-power-read-only");

  beforeEach(() => {
    catalog.clear();
    preferences = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
    runInAction(() => preferences.fromStore({ enabled: false }));
    document.body.innerHTML = `
      <div class="KubeObjectListLayout"><div class="AddRemoveButtons"><button id="create" class="add-button">Create</button></div></div>
      <ul class="MenuActions"><li id="edit" class="MenuItem" data-testid="menu-action-edit-for-/example">Edit</li>
        <li id="force-delete" class="MenuItem" data-testid="menu-action-force-delete-for-/example"><span class="title">Force Delete</span><i data-icon-name="delete_forever"></i></li>
        <li id="drain" class="MenuItem"><span class="title">Drain</span></li>
        <li id="remove-cluster" class="MenuItem"><i data-icon-name="delete"></i></li>
        <li id="logs" class="MenuItem"><span class="title">Logs</span></li></ul>
      <div class="ItemListLayout"><div class="AddRemoveButtons"><button id="floating-remove" class="remove-button">Remove</button></div></div>
      <div class="CatalogAddButton" id="add-cluster"><button>Add</button></div>
      <ul class="MenuActions"><li class="MenuItem" id="catalog-remove">Remove</li></ul>
      <div class="power-ai-panel"><div class="MenuActions"><button class="MenuItem" id="ai-edit">Edit</button></div></div>
      <a id="nav" href="#catalog">Add-ons</a>
      <div class="freelens-power-preferences"><div class="MenuActions"><button id="settings" class="MenuItem"><span class="title">Delete</span></button></div></div>
      <div class="freelens-power-dashboard"><button id="dashboard">Add card</button></div>
      <div class="CreateResource"><div class="InfoPanel"><button id="apply" class="active">Create</button><button id="cancel">Cancel</button></div></div>`;
  });
  afterEach(() => {
    dispose?.();
    document.body.innerHTML = "";
  });

  it("defaults off and restores native controls after disabling or disposal", () => {
    expect(preferences.toJSON()).toEqual({ enabled: false });
    dispose = startReadOnlyMode();
    expect(hidden("edit")).toBe(false);
    runInAction(() => {
      preferences.enabled = true;
    });
    for (const id of [
      "create",
      "edit",
      "force-delete",
      "drain",
      "remove-cluster",
      "apply",
      "catalog-remove",
      "floating-remove",
    ])
      expect(hidden(id)).toBe(true);
    for (const id of ["logs", "nav", "settings", "dashboard", "cancel", "ai-edit", "add-cluster"])
      expect(hidden(id)).toBe(false);
    runInAction(() => {
      preferences.enabled = false;
    });
    expect(hidden("edit")).toBe(false);
    runInAction(() => {
      preferences.enabled = true;
    });
    dispose();
    expect(hidden("edit")).toBe(false);
    expect(document.querySelector('style[data-freelens-power="read-only"]')).toBeNull();
  });

  it("allows opening cluster import with the pointer and keyboard while read-only mode is enabled", () => {
    runInAction(() => {
      preferences.enabled = true;
    });
    dispose = startReadOnlyMode();
    const add = document.querySelector<HTMLButtonElement>("#add-cluster button")!;
    const activate = vi.fn();
    add.addEventListener("click", activate);
    add.addEventListener("keydown", activate);
    expect(add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(true);
    for (const key of ["Enter", " "]) {
      expect(add.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))).toBe(true);
    }
    expect(activate).toHaveBeenCalledTimes(3);
    expect(hidden("add-cluster")).toBe(false);
    expect(hidden("create")).toBe(true);
    expect(hidden("remove-cluster")).toBe(true);
  });

  it("allows local Web Link menus and kubeconfig navigation without enabling cluster or resource mutations", async () => {
    for (const [id, kind, source] of [
      ["local-link", "WebLink", "local"],
      ["dashboard-link", "WebLink", "freelens-power"],
      ["local-cluster", "KubernetesCluster", "local"],
    ])
      catalog.set(id, { apiVersion: "entity.k8slens.dev/v1alpha1", kind, metadata: { source } });
    runInAction(() => {
      preferences.enabled = true;
    });
    dispose = startReadOnlyMode();
    for (const id of ["local-link", "dashboard-link", "local-cluster", "unknown"]) {
      const menu = document.createElement("ul");
      menu.className = "MenuActions";
      menu.dataset.testid = `menu-actions-for-catalog-for-${id}`;
      menu.innerHTML = `<li class="MenuItem" id="delete-${id}"><i class="Icon" data-icon-name="delete">delete</i>Delete</li>`;
      document.body.append(menu);
    }
    const drawer = document.createElement("ul");
    drawer.id = "menu-actions-for-catalog-entity-drawer-menu-local-link";
    drawer.className = "MenuActions";
    drawer.innerHTML = '<li class="MenuItem" id="drawer-delete-link">Delete</li>';
    document.body.append(drawer);
    const open = document.createElement("li");
    open.className = "MenuItem";
    open.id = "open-kubeconfig";
    open.innerHTML =
      '<span data-power-catalog-menu-icon><i class="Icon" data-icon-name="edit">edit</i></span>Open kubeconfig';
    document.querySelector(".MenuActions")!.append(open);
    await Promise.resolve();
    for (const id of ["delete-local-link", "drawer-delete-link", "open-kubeconfig"]) {
      expect(hidden(id)).toBe(false);
      expect(
        document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
      ).toBe(true);
    }
    for (const id of ["delete-dashboard-link", "delete-local-cluster", "delete-unknown", "edit"])
      expect(hidden(id)).toBe(true);
  });

  it("handles dynamically mounted actions and intercepts their activation only", async () => {
    runInAction(() => {
      preferences.enabled = true;
    });
    dispose = startReadOnlyMode();
    const onClick = vi.fn();
    document.body.addEventListener("click", onClick);
    const dynamic = document.createElement("button");
    dynamic.dataset.testid = "menu-action-delete-for-/example";
    document.body.append(dynamic);
    expect(dynamic.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(dynamic.hasAttribute("data-freelens-power-read-only")).toBe(true);
    document.getElementById("logs")?.click();
    document.getElementById("settings")?.click();
    expect(onClick).toHaveBeenCalledTimes(2);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    expect(dynamic.dispatchEvent(enter)).toBe(false);
    document.body.removeEventListener("click", onClick);
  });
});
