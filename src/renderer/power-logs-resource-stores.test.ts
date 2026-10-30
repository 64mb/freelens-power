import { expect, it, vi } from "vitest";
import { subscribeLogResourceStores } from "./power-logs-resource-stores";

it("loads native namespaces before loading resources in the current context", async () => {
  let finish!: () => void;
  const namespaceStore = {
    loadAll: vi.fn(
      (_options: { reqInit: { signal: AbortSignal } }) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const store = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockReturnValue(() => {}) };
  const stop = subscribeLogResourceStores([store], () => () => {}, namespaceStore);
  expect(namespaceStore.loadAll).toHaveBeenCalledOnce();
  expect(store.loadAll).not.toHaveBeenCalled();
  finish();
  await Promise.resolve();
  expect(store.loadAll).toHaveBeenCalledOnce();
  stop();
});

it("cancels namespace initialization without starting resource requests after disposal", async () => {
  let finish!: () => void;
  const namespaceStore = {
    loadAll: vi.fn(
      (_options: { reqInit: { signal: AbortSignal } }) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const store = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn() };
  const stop = subscribeLogResourceStores([store], () => () => {}, namespaceStore);
  stop();
  finish();
  await Promise.resolve();
  expect(namespaceStore.loadAll.mock.calls[0][0].reqInit.signal.aborted).toBe(true);
  expect(store.loadAll).not.toHaveBeenCalled();
});

function setup() {
  let namespaceChanged = () => {};
  const stopNamespaces = vi.fn();
  const unsubscribe = vi.fn();
  const store = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockReturnValue(unsubscribe) };
  const stop = subscribeLogResourceStores([store], (callback) => {
    namespaceChanged = callback;
    return stopNamespaces;
  });
  return { store, stop, unsubscribe, stopNamespaces, namespaceChanged: () => namespaceChanged() };
}

it("loads native context resources before watching and cancels everything on disposal", async () => {
  const state = setup();
  expect(state.store.subscribe).not.toHaveBeenCalled();
  expect(state.store.loadAll).toHaveBeenCalledWith({
    reqInit: { signal: expect.any(AbortSignal) },
    onLoadFailure: expect.any(Function),
  });
  await Promise.resolve();
  expect(state.store.subscribe).toHaveBeenCalledOnce();
  state.stop();
  expect(state.store.loadAll.mock.calls[0][0].reqInit.signal.aborted).toBe(true);
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.stopNamespaces).toHaveBeenCalledOnce();
});

it("cancels the previous context load before loading changed namespaces", async () => {
  const state = setup();
  const firstSignal = state.store.loadAll.mock.calls[0][0].reqInit.signal;
  state.namespaceChanged();
  expect(firstSignal.aborted).toBe(true);
  expect(state.store.loadAll).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(state.store.subscribe).toHaveBeenCalledOnce();
  state.stop();
});

it("disposes existing watches before subscribing in the new namespace context", async () => {
  const state = setup();
  await Promise.resolve();
  state.namespaceChanged();
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(state.store.subscribe).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(state.store.subscribe).toHaveBeenCalledTimes(2);
  state.stop();
  expect(state.unsubscribe).toHaveBeenCalledTimes(2);
});

it("does not start late watches after unmount and isolates inaccessible resource types", async () => {
  const deniedStore = { loadAll: vi.fn().mockRejectedValue(new Error("forbidden")), subscribe: vi.fn() };
  let finish!: () => void;
  const pendingStore = {
    loadAll: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
    subscribe: vi.fn(),
  };
  const availableStore = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockReturnValue(() => {}) };
  const stop = subscribeLogResourceStores([deniedStore, pendingStore, availableStore], () => () => {});
  await Promise.resolve();
  expect(availableStore.subscribe).toHaveBeenCalledOnce();
  stop();
  finish();
  await Promise.resolve();
  expect(deniedStore.subscribe).not.toHaveBeenCalled();
  expect(pendingStore.subscribe).not.toHaveBeenCalled();
});

it("reports native callback failures even when loadAll resolves successfully", async () => {
  const states = vi.fn();
  const store = {
    loadAll: vi.fn(async ({ onLoadFailure }: { onLoadFailure(error: unknown): void }) => {
      onLoadFailure(new Error("forbidden"));
      return [];
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
  const stop = subscribeLogResourceStores([store], () => () => {}, undefined, states);
  await vi.waitFor(() => expect(states).toHaveBeenLastCalledWith({ loading: false, failed: true }));
  stop();
});

it("distinguishes a successful empty resource list from a loading failure", async () => {
  const states = vi.fn();
  const store = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockReturnValue(() => {}) };
  const stop = subscribeLogResourceStores([store], () => () => {}, undefined, states);
  expect(states).toHaveBeenCalledWith({ loading: true, failed: false });
  await vi.waitFor(() => expect(states).toHaveBeenLastCalledWith({ loading: false, failed: false }));
  stop();
});

it("retains namespace initialization failures while loading available resources", async () => {
  const states = vi.fn();
  const namespaceStore = {
    loadAll: vi.fn(async ({ onLoadFailure }: { onLoadFailure(error: unknown): void }) => {
      onLoadFailure(new Error("forbidden"));
      return [];
    }),
  };
  const store = { loadAll: vi.fn().mockResolvedValue([]), subscribe: vi.fn().mockReturnValue(() => {}) };
  const stop = subscribeLogResourceStores([store], () => () => {}, namespaceStore, states);
  await vi.waitFor(() => expect(states).toHaveBeenLastCalledWith({ loading: false, failed: true }));
  expect(store.loadAll).toHaveBeenCalledOnce();
  stop();
});

it("does not publish stale loading results after disposal", async () => {
  const states = vi.fn();
  let finish!: () => void;
  const store = {
    loadAll: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
    subscribe: vi.fn(),
  };
  const stop = subscribeLogResourceStores([store], () => () => {}, undefined, states);
  stop();
  states.mockClear();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(states).not.toHaveBeenCalled();
});

it("populates native contextItems when opened before namespace and resource stores have loaded", async () => {
  let namespaces: string[] = [];
  const objects = [{ kind: "Pod", metadata: { name: "worker", namespace: "sample", uid: "pod-a" } }];
  const store = {
    items: [] as typeof objects,
    get contextItems() {
      return this.items.filter((object) => namespaces.includes(object.metadata.namespace));
    },
    loadAll: vi.fn(async () => {
      store.items = objects.filter((object) => namespaces.includes(object.metadata.namespace));
      return store.items;
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
  const namespaceStore = {
    loadAll: vi.fn(async () => {
      await Promise.resolve();
      namespaces = ["sample"];
      return namespaces;
    }),
  };
  expect(store.contextItems).toEqual([]);
  const stop = subscribeLogResourceStores([store], () => () => {}, namespaceStore);
  await vi.waitFor(() => expect(store.contextItems).toEqual(objects));
  expect(store.subscribe).toHaveBeenCalledOnce();
  stop();
});
