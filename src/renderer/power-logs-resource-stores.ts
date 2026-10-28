interface ResourceStore {
  loadAll(options: { reqInit: { signal: AbortSignal }; onLoadFailure(error: unknown): void }): Promise<unknown>;
  subscribe(options: { abortController: AbortController; onLoadFailure(error: unknown): void }): () => void;
}

export function subscribeLogResourceStores(
  stores: ResourceStore[],
  onNamespaceChange: (callback: () => void) => () => void,
  namespaceStore?: Pick<ResourceStore, "loadAll">,
): () => void {
  let stop = () => {};
  const bootstrap = new AbortController();
  const reload = () => {
    stop();
    const controller = new AbortController();
    const unsubscribers: (() => void)[] = [];
    const onLoadFailure = () => {};
    stop = () => {
      controller.abort();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    for (const store of stores) {
      void store
        .loadAll({ reqInit: { signal: controller.signal }, onLoadFailure })
        .then(() => {
          if (!controller.signal.aborted) {
            unsubscribers.push(store.subscribe({ abortController: controller, onLoadFailure }));
          }
        })
        .catch(onLoadFailure);
    }
  };
  let stopNamespaceChanges = () => {};
  const start = () => {
    if (bootstrap.signal.aborted) return;
    stopNamespaceChanges = onNamespaceChange(reload);
    reload();
  };
  if (namespaceStore) {
    void namespaceStore.loadAll({ reqInit: { signal: bootstrap.signal }, onLoadFailure: () => {} }).then(start, start);
  } else start();
  return () => {
    bootstrap.abort();
    stopNamespaceChanges();
    stop();
  };
}
