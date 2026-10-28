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
