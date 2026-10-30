interface ResourceStore {
  loadAll(options: { reqInit: { signal: AbortSignal }; onLoadFailure(error: unknown): void }): Promise<unknown>;
  subscribe(options: { abortController: AbortController; onLoadFailure(error: unknown): void }): () => void;
}

export interface LogResourceStoresState {
  loading: boolean;
  failed: boolean;
}

export function subscribeLogResourceStores(
  stores: ResourceStore[],
  onNamespaceChange: (callback: () => void) => () => void,
  namespaceStore?: Pick<ResourceStore, "loadAll">,
  onStateChange: (state: LogResourceStoresState) => void = () => {},
): () => void {
  let stop = () => {};
  const bootstrap = new AbortController();
  const reload = () => {
    stop();
    const controller = new AbortController();
    const unsubscribers: (() => void)[] = [];
    let pending = stores.length;
    let failed = namespaceFailed;
    const publish = () => {
      if (!controller.signal.aborted) onStateChange({ loading: pending > 0, failed });
    };
    const onLoadFailure = () => {
      failed = true;
      publish();
    };
    publish();
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
        .catch(onLoadFailure)
        .finally(() => {
          pending -= 1;
          publish();
        });
    }
  };
  let namespaceFailed = false;
  let stopNamespaceChanges = () => {};
  const start = () => {
    if (bootstrap.signal.aborted) return;
    stopNamespaceChanges = onNamespaceChange(reload);
    reload();
  };
  if (namespaceStore) {
    onStateChange({ loading: true, failed: false });
    const onLoadFailure = () => {
      namespaceFailed = true;
    };
    void namespaceStore.loadAll({ reqInit: { signal: bootstrap.signal }, onLoadFailure }).then(start, () => {
      onLoadFailure();
      start();
    });
  } else start();
  return () => {
    bootstrap.abort();
    stopNamespaceChanges();
    stop();
  };
}
