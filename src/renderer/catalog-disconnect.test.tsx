// @vitest-environment jsdom

import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  items: [] as any[],
  confirm: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Common: { Catalog: { KubernetesCluster: { apiVersion: "example/v1", kind: "KubernetesCluster" } } },
  Renderer: {
    Catalog: { catalogEntities: { getItemsForApiKind: () => state.items } },
    Component: { Icon: () => null, ConfirmDialog: { open: state.confirm }, Notifications: { error: state.error } },
  },
}));
vi.mock("./react-roots", () => ({ renderIntoContainer: state.render, unmountContainer: state.unmount }));

import { startCatalogDisconnect } from "./catalog-disconnect";

const disposers: (() => void)[] = [];
const entity = (id: string, phase: string) => ({
  getId: () => id,
  status: observable({ phase }),
  disconnect: vi.fn(async () => {}),
});
const button = () => state.render.mock.calls.at(-1)![0].props.children.props;
const start = (category = "Clusters") => {
  document.body.innerHTML = `<main><div><div data-testid="catalog-list-for-${category}"></div></div><div class="CatalogAddButton"></div></main>`;
  const stop = startCatalogDisconnect();
  disposers.push(stop);
  return stop;
};
afterEach(() => {
  for (const stop of disposers.splice(0)) stop();
  document.body.innerHTML = "";
  state.items = [];
  vi.clearAllMocks();
});

it("shows the button only in Clusters while active connections exist", () => {
  const stopOther = start("Web Links");
  expect(state.render).not.toHaveBeenCalled();
  stopOther();
  state.items = observable.array([]);
  start();
  expect(document.querySelector(".power-catalog-disconnect")).toBeNull();
  const cluster = entity("cluster-a", "connected");
  runInAction(() => state.items.push(cluster));
  expect(button().disabled).toBe(false);
  expect(document.querySelector(".CatalogAddButton")?.previousElementSibling?.className).toBe(
    "power-catalog-disconnect",
  );
  runInAction(() => {
    cluster.status.phase = "disconnected";
  });
  expect(document.querySelector(".power-catalog-disconnect")).toBeNull();
});

it("requires confirmation, counts active entries, and cancels without side effects", async () => {
  const cluster = entity("cluster-a", "connected");
  state.items = [cluster, entity("cluster-b", "disconnected")];
  start();
  button().onClick();
  expect(state.confirm.mock.calls[0][0].message).toBe("Disconnect 1 active cluster?");
  expect(cluster.disconnect).not.toHaveBeenCalled();
  expect(button().disabled).toBe(true);
  state.confirm.mock.calls[0][0].cancel();
  await state.confirm.mock.calls[0][0].ok();
  expect(button().disabled).toBe(false);
  expect(cluster.disconnect).not.toHaveBeenCalled();
});

it("rechecks snapshot identity and status and ignores newly connected entries", async () => {
  const connected = entity("cluster-a", "connected");
  const connecting = entity("cluster-b", "connecting");
  const inactive = entity("cluster-c", "disconnected");
  const replaced = entity("cluster-d", "connected");
  const changed = entity("cluster-e", "connected");
  state.items = [connected, connecting, inactive, replaced, changed];
  start();
  button().onClick();
  runInAction(() => {
    inactive.status.phase = "connected";
    changed.status.phase = "disconnected";
  });
  const replacement = entity("cluster-d", "connected");
  state.items = [connected, connecting, inactive, replacement, changed];
  const confirm = state.confirm.mock.calls[0][0];
  await Promise.all([confirm.ok(), confirm.ok()]);
  expect(connected.disconnect).toHaveBeenCalledTimes(1);
  expect(connecting.disconnect).toHaveBeenCalledTimes(1);
  for (const item of [inactive, replaced, replacement, changed]) expect(item.disconnect).not.toHaveBeenCalled();
});

it("removes its host and reaction and ignores stale confirmations after disposal", async () => {
  const cluster = entity("cluster-a", "connecting");
  state.items = [cluster];
  const stop = start();
  button().onClick();
  stop();
  const renders = state.render.mock.calls.length;
  runInAction(() => {
    cluster.status.phase = "disconnected";
  });
  await state.confirm.mock.calls[0][0].ok();
  expect(cluster.disconnect).not.toHaveBeenCalled();
  expect(document.querySelector(".power-catalog-disconnect")).toBeNull();
  expect(state.render).toHaveBeenCalledTimes(renders);
});

it("reports failures without exposing entity details", async () => {
  const cluster = entity("cluster-a", "connected");
  cluster.disconnect.mockRejectedValue(new Error("private detail"));
  state.items = [cluster];
  start();
  button().onClick();
  await state.confirm.mock.calls[0][0].ok();
  expect(state.error).toHaveBeenCalledWith("Unable to disconnect some clusters. Check their connection status.");
  expect(button().disabled).toBe(false);
});
