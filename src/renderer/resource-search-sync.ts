import {
  collectionPath,
  discoverSearchCollections,
  type MetadataPage,
  projectMetadataPage,
  type SearchCollection,
  type SearchTransport,
  searchErrorStatus,
} from "./resource-search-discovery";

import type { SearchDocument } from "../common/resource-search";

export interface SearchSink {
  begin(scope: string, scanId: string): Promise<unknown>;
  append(scope: string, scanId: string, documents: SearchDocument[]): Promise<unknown>;
  complete(scope: string, scanId: string): Promise<unknown>;
  invalidate(scope: string): Promise<unknown>;
  reconcile?(resources: string[]): Promise<unknown>;
}
export interface SearchCoverage {
  scanned: number;
  discovered: number;
  denied: number;
  unavailable: number;
  unsupported: number;
  indexing: boolean;
  message?: string;
  kinds?: string[];
  namespaces?: string[];
  completedAt?: number;
  storageFull?: boolean;
}
export const SEARCH_STORAGE_FULL_MESSAGE = "Search storage is full; clear the local search cache to continue";
export const isSearchStorageFull = (error: unknown): boolean =>
  error instanceof Error && error.message.endsWith(SEARCH_STORAGE_FULL_MESSAGE);
const metadataAccept = { Accept: "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1" };
export function createSearchSynchronizer(options: {
  transport: SearchTransport;
  sink: SearchSink;
  signal: AbortSignal;
  onStatus(status: SearchCoverage): void;
  namespaces?: () => string[];
  delay?: (milliseconds: number) => Promise<void>;
  refreshMs?: number;
}) {
  const { transport, sink, signal } = options;
  const status: SearchCoverage = {
    scanned: 0,
    discovered: 0,
    denied: 0,
    unavailable: 0,
    unsupported: 0,
    indexing: true,
  };
  const emit = () => options.onStatus({ ...status });
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener("abort", done, { once: true });
      }));
  let sequence = 0;
  let nextRequest = 0;
  const request = async <T>(
    path: string,
    query?: Record<string, string | number>,
    headers?: Record<string, string>,
  ): Promise<T> => {
    await delay(Math.max(0, nextRequest - Date.now()));
    if (signal.aborted) throw new Error("Search synchronization canceled");
    nextRequest = Date.now() + 500;
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport.get<T>(path, query, headers);
      } catch (error) {
        const code = searchErrorStatus(error);
        if (signal.aborted || attempt >= 3 || (code !== 429 && code < 500)) throw error;
        const retry = (error as { headers?: { get?(name: string): string | null }; retryAfter?: string }).retryAfter;
        const retryMilliseconds = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : NaN;
        await delay(
          Number.isFinite(retryMilliseconds)
            ? Math.min(86400000, Math.max(0, retryMilliseconds))
            : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 250,
        );
      }
    }
  };
  const limited: SearchTransport = { get: request };
  const scan = async (type: SearchCollection, namespace?: string): Promise<void> => {
    const scope = `${type.group}/${type.resource}/${namespace ?? "*"}`;
    for (let restart = 0; restart < 2; restart++) {
      const scanId = `${Date.now()}-${++sequence}`;
      await sink.begin(scope, scanId);
      let continuation = "";
      let pageSize = 250;
      const seen = new Set<string>();
      try {
        do {
          let page: MetadataPage;
          for (;;) {
            const query = { limit: pageSize, ...(continuation ? { continue: continuation } : {}) };
            try {
              try {
                page = await request<MetadataPage>(collectionPath(type, namespace), query, metadataAccept);
              } catch (error) {
                if (searchErrorStatus(error) !== 406 || !type.group) throw error;
                page = await request<MetadataPage>(collectionPath(type, namespace), query, {
                  Accept: "application/json",
                });
              }
              break;
            } catch (error) {
              if (!(error as { oversized?: boolean }).oversized || pageSize === 1) throw error;
              pageSize = Math.max(1, Math.floor(pageSize / 2));
            }
          }
          if (signal.aborted) return;
          const documents = projectMetadataPage(type, page);
          status.namespaces = [
            ...new Set([
              ...(status.namespaces ?? []),
              ...documents.flatMap((document) => (document.namespace ? [document.namespace] : [])),
            ]),
          ].sort();
          await sink.append(scope, scanId, documents);
          continuation = page.metadata?.continue ?? "";
          if (continuation && seen.has(continuation)) throw new Error("Repeated inventory continuation");
          seen.add(continuation);
        } while (continuation);
        if (!signal.aborted) await sink.complete(scope, scanId);
        return;
      } catch (error) {
        const code = searchErrorStatus(error);
        if (code === 410 && restart === 0) continue;
        if (code === 403) await sink.invalidate(scope);
        throw error;
      }
    }
  };
  return {
    async run(): Promise<void> {
      try {
        while (!signal.aborted) {
          status.indexing = true;
          status.scanned = 0;
          status.denied = 0;
          status.unavailable = 0;
          status.unsupported = 0;
          status.message = undefined;
          emit();
          let discoveryFailures = 0;
          const collections = await discoverSearchCollections(limited, () => {
            discoveryFailures++;
            status.unavailable++;
            emit();
          });
          if (signal.aborted) return;
          if (discoveryFailures === 0)
            await sink.reconcile?.(collections.map((type) => `${type.group}/${type.resource}`));
          else status.message = "API discovery incomplete; cached resource types may be stale";
          status.kinds = [...new Set(collections.map((type) => type.kind))].sort();
          status.discovered = collections.length;
          emit();
          let fallbackNamespaces: string[] | undefined;
          for (const type of collections) {
            if (signal.aborted) return;
            try {
              await scan(type);
            } catch (error) {
              if (signal.aborted) return;
              if (isSearchStorageFull(error)) throw error;
              if (searchErrorStatus(error) === 403) {
                status.denied++;
                if (type.namespaced) {
                  let namespaces = fallbackNamespaces ?? options.namespaces?.() ?? [];
                  if (fallbackNamespaces === undefined) {
                    try {
                      const namespaceType: SearchCollection = {
                        group: "",
                        version: "v1",
                        resource: "namespaces",
                        kind: "Namespace",
                        namespaced: false,
                        aliases: [],
                      };
                      let token = "";
                      let limit = 250;
                      const seen = new Set<string>();
                      do {
                        let page: MetadataPage;
                        for (;;) {
                          try {
                            page = await request<MetadataPage>(
                              collectionPath(namespaceType),
                              { limit, ...(token ? { continue: token } : {}) },
                              metadataAccept,
                            );
                            break;
                          } catch (error) {
                            if (!(error as { oversized?: boolean }).oversized || limit === 1) throw error;
                            limit = Math.max(1, Math.floor(limit / 2));
                          }
                        }
                        namespaces = [
                          ...new Set([
                            ...namespaces,
                            ...(page.items ?? []).flatMap((item) => (item.metadata?.name ? [item.metadata.name] : [])),
                          ]),
                        ];
                        token = page.metadata?.continue ?? "";
                        if (token && seen.has(token)) throw new Error("Repeated namespace continuation");
                        seen.add(token);
                      } while (token);
                    } catch {
                      status.message = "Namespace discovery denied or incomplete; add a known namespace to continue";
                    }
                    fallbackNamespaces = namespaces;
                  }
                  for (const namespace of namespaces) {
                    if (signal.aborted) return;
                    try {
                      await scan(type, namespace);
                    } catch (failure) {
                      if (isSearchStorageFull(failure)) throw failure;
                      if (searchErrorStatus(failure) === 403) status.denied++;
                      else status.unavailable++;
                    }
                  }
                }
              } else if (searchErrorStatus(error) === 406) status.unsupported++;
              else status.unavailable++;
            }
            status.scanned++;
            emit();
          }
          status.indexing = false;
          status.completedAt = Date.now();
          emit();
          await delay(options.refreshMs ?? 10 * 60 * 1000);
        }
      } catch (error) {
        if (!isSearchStorageFull(error)) throw error;
        status.indexing = false;
        status.storageFull = true;
        status.message = SEARCH_STORAGE_FULL_MESSAGE;
        emit();
      }
    },
  };
}
