import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { observer } from "mobx-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { explainDiagnosticFinding } from "./ai-diagnostic-handoff";
import { AiIcon } from "./ai-icon";
import { DiagnosticExplainButton } from "./diagnostic-explain-button";
import { createResourceSearchClient, createResourceSearchTransport, searchContextId } from "./resource-search-client";
import { projectSearchFields } from "./resource-search-fields";
import {
  createDoubleShift,
  createResourceSearchIndex,
  queryTokens,
  type SearchResource,
} from "./resource-search-model";
import { closeSearchResourceFallback, openSearchResource } from "./resource-search-routing";
import { createSearchSynchronizer, type SearchCoverage } from "./resource-search-sync";

import type { SearchDocument } from "../common/resource-search";

const OPEN = "power-resource-search";
const activeId = () => Renderer.Catalog.activeCluster.get()?.metadata.uid;
const inventory = () =>
  [
    ["Pod", Renderer.K8sApi.podsStore, "view_in_ar"],
    ["Node", Renderer.K8sApi.nodesStore, "dns"],
    ["Deployment", Renderer.K8sApi.deploymentStore, "layers"],
    ["StatefulSet", Renderer.K8sApi.statefulSetStore, "layers"],
    ["DaemonSet", Renderer.K8sApi.daemonSetStore, "layers"],
    ["ReplicaSet", Renderer.K8sApi.replicaSetStore, "layers"],
    ["Job", Renderer.K8sApi.jobStore, "work"],
    ["CronJob", Renderer.K8sApi.cronJobStore, "schedule"],
    ["Service", Renderer.K8sApi.serviceStore, "settings_ethernet"],
    ["Ingress", Renderer.K8sApi.ingressStore, "alt_route"],
    ["Namespace", Renderer.K8sApi.namespaceStore, "folder"],
    ["HorizontalPodAutoscaler", Renderer.K8sApi.hpaStore, "swap_vert"],
  ] as const;
const icons = new Map(inventory().map(([kind, , icon]) => [kind as string, icon]));

export const ResourceSearchLauncher = observer(() => {
  if (!MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>().resourceSearchEnabled) return null;
  return (
    <button
      type="button"
      title="Search resources (double Shift)"
      aria-label="Search resources"
      onClick={() => window.dispatchEvent(new Event(OPEN))}
    >
      <AiIcon material="search" />
    </button>
  );
});

function SearchSnippet({ field, query }: { field?: { label: string; text: string }; query: string }) {
  if (!field) return null;
  const token = queryTokens(query).find((token) => field.text.toLocaleLowerCase().includes(token));
  const offset = token ? field.text.toLocaleLowerCase().indexOf(token) : -1;
  return (
    <small className="power-resource-search-snippet">
      {field.label}:{" "}
      {offset < 0 || !token ? (
        field.text
      ) : (
        <>
          {field.text.slice(0, offset)}
          <mark>{field.text.slice(offset, offset + token.length)}</mark>
          {field.text.slice(offset + token.length)}
        </>
      )}
    </small>
  );
}

function SearchDialog({ close, clusterId }: { close: () => void; clusterId: string }) {
  const [query, setQuery] = useState("");
  const [knownNamespace, setKnownNamespace] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("");
  const [resources, setResources] = useState<SearchResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(0);
  const [cachedCount, setCachedCount] = useState<number>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchIndex = useMemo(() => createResourceSearchIndex(resources), [resources]);
  const matches = searchIndex.search(query);
  const selectedResource = matches.find((resource) => resource.path === selectedPath) ?? matches[0];
  const results = matches;
  if (selectedResource && !results.includes(selectedResource)) results[results.length - 1] = selectedResource;
  const selected = results.findIndex((resource) => resource.path === selectedResource?.path);
  useEffect(() => {
    if (selectedPath !== undefined && selectedPath !== selectedResource?.path) setSelectedPath(undefined);
  }, [selectedPath, selectedResource?.path]);
  const [coverage, setCoverage] = useState<SearchCoverage>(currentCoverage);
  const [limit, setLimit] = useState(100);
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const update = () => setCoverage({ ...currentCoverage });
    window.addEventListener("power-search-coverage", update);
    return () => {
      window.removeEventListener("power-search-coverage", update);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let live = true;
    const client = createResourceSearchClient(clusterId, searchContextId());
    const timer = window.setTimeout(() => {
      void client
        .query(query, limit, {
          ...(kindFilter
            ? {
                kind:
                  coverage.kinds?.find((kind) => kind.toLocaleLowerCase() === kindFilter.toLocaleLowerCase()) ??
                  kindFilter,
              }
            : {}),
          ...(namespaceFilter ? { namespace: namespaceFilter === "(cluster)" ? "" : namespaceFilter } : {}),
        })
        .then((result) => {
          if (!live || activeId() !== clusterId) return;
          setResources(result.documents);
          setHasMore(result.hasMore);
          setLoading(false);
          setFailed(0);
          void client
            .status?.()
            .then((status) => {
              if (live) setCachedCount(status.count);
            })
            .catch(() => {});
        })
        .catch(() => {
          if (live) {
            setFailed(1);
            setLoading(false);
          }
        });
    }, 100);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [clusterId, query, limit, kindFilter, namespaceFilter, coverage.scanned, coverage.indexing]);
  useEffect(() => {
    document.getElementById(`power-resource-result-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected, selectedResource?.path]);
  const clearCache = () => {
    void createResourceSearchClient(clusterId, searchContextId())
      .clear()
      .then(() => {
        setResources([]);
        restartSearchSync();
      })
      .catch(() => setError("Could not clear the local search cache. Try again."));
  };
  const open = (resource: SearchResource) => {
    if (activeId() !== clusterId) return;
    void Promise.resolve()
      .then(() => openSearchResource(resource as SearchDocument))
      .then(() => {
        if (activeId() === clusterId) close();
      })
      .catch(() => setError("Could not open this resource. Try again or refresh the inventory."));
  };
  return (
    <div
      className="power-resource-search-backdrop"
      data-freelens-power-ai-overlay=""
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="power-resource-search-title"
        className="power-resource-search-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled), select") ?? [],
            );
            const index = controls.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index <= 0) {
              event.preventDefault();
              controls.at(-1)?.focus();
            } else if (!event.shiftKey && index === controls.length - 1) {
              event.preventDefault();
              controls[0]?.focus();
            }
          }
        }}
      >
        <div className="power-resource-search-heading">
          <strong id="power-resource-search-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AiIcon material="search" size={18} />
            Search resources
          </strong>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              aria-label="Refresh resource inventory"
              title="Refresh resource inventory"
              onClick={() => restartSearchSync()}
            >
              <AiIcon material="refresh" />
            </button>
            <button type="button" aria-label="Close resource search" onClick={close}>
              <AiIcon material="close" />
            </button>
          </div>
        </div>
        <input
          ref={input}
          aria-label="Resource name, namespace, kind, label or indexed text"
          aria-controls="power-resource-search-results"
          placeholder="Name, namespace, label, image, condition…"
          maxLength={300}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedPath(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = results.length
                ? (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length
                : 0;
              setSelectedPath(results[next]?.path);
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing && results[selected]) {
              event.preventDefault();
              open(results[selected]);
            }
          }}
        />
        <div className="power-resource-search-filters" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            list="power-search-kinds"
            aria-label="Filter by exact resource kind"
            placeholder="Kind (all types)"
            value={kindFilter}
            maxLength={253}
            onChange={(event) => {
              setKindFilter(event.target.value);
              setSelectedPath(undefined);
            }}
          />
          <input
            list="power-search-namespaces"
            aria-label="Filter by exact namespace"
            placeholder="Namespace (all)"
            value={namespaceFilter}
            maxLength={253}
            onChange={(event) => {
              setNamespaceFilter(event.target.value);
              setSelectedPath(undefined);
            }}
          />
        </div>
        <datalist id="power-search-kinds">
          {(coverage.kinds ?? []).map((kind) => (
            <option key={kind} value={kind} />
          ))}
        </datalist>
        <datalist id="power-search-namespaces">
          <option value="(cluster)">Cluster scoped</option>
          {(coverage.namespaces ?? []).map((namespace) => (
            <option key={namespace} value={namespace} />
          ))}
        </datalist>
        <p role="status">
          {coverage.indexing
            ? `Indexing ${coverage.scanned}/${coverage.discovered} types`
            : coverage.completedAt
              ? `Updated ${new Date(coverage.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Cached inventory"}
          {cachedCount !== undefined && ` · ${cachedCount.toLocaleString()} resources`}
          {coverage.denied > 0 && ` · ${coverage.denied} restricted scopes`}
          {coverage.unavailable + coverage.unsupported > 0 &&
            ` · ${coverage.unavailable + coverage.unsupported} APIs unavailable`}
          {failed > 0 && " · Search cache unavailable"}
        </p>
        {(coverage.message || coverage.denied > 0 || coverage.unavailable + coverage.unsupported > 0) && (
          <details>
            <summary>Inventory coverage</summary>
            <p>
              {coverage.message ?? "Results include the resources your current permissions and available APIs allow."}
            </p>
          </details>
        )}
        {coverage.storageFull && (
          <div role="alert">
            <p>Local search storage is full. Cached results are partial; indexing is paused.</p>
            <button type="button" onClick={clearCache}>
              Clear local search cache
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <div
          id="power-resource-search-results"
          role="list"
          aria-label="Matching resources"
          className="power-resource-search-results"
        >
          {results.map((resource, index) => (
            <div
              key={resource.path}
              id={`power-resource-result-${index}`}
              role="listitem"
              className={`power-resource-search-row ${selected === index ? "selected" : ""}`}
            >
              <button className="power-resource-search-open" type="button" onClick={() => open(resource)}>
                <AiIcon material={icons.get(resource.kind) ?? "view_in_ar"} />
                <span>
                  <strong>{resource.name}</strong>
                  <small>
                    {resource.kind} · {resource.namespace ?? "cluster scoped"}
                  </small>
                  {searchIndex.nameParts(resource) && <small>Name parts</small>}
                  {searchIndex.similarName(resource) && <small>Similar name</small>}
                  <SearchSnippet field={searchIndex.snippet(resource, query)} query={query} />
                </span>
              </button>
              <DiagnosticExplainButton
                className="power-resource-search-ai"
                aria-label={`Ask AI about ${resource.kind} ${resource.name}`}
                title="Ask AI about this resource"
                onClick={() => {
                  if (activeId() !== clusterId) return;
                  close();
                  explainDiagnosticFinding({
                    clusterId,
                    title: `${resource.kind}: ${resource.name}`,
                    summary: `Resource selected from search. API group: ${(resource as SearchDocument).group || "core"}; version: ${(resource as SearchDocument).version}; resource: ${(resource as SearchDocument).resource}; kind: ${resource.kind}; namespace: ${resource.namespace ?? "cluster scoped"}; name: ${resource.name}; UID: ${(resource as SearchDocument).uid ?? "unknown"}; path: ${resource.path}. No live diagnostic data was collected.`,
                    resource: { kind: resource.kind, name: resource.name, namespace: resource.namespace },
                  });
                }}
              >
                <AiIcon material="auto_awesome" />
              </DiagnosticExplainButton>
            </div>
          ))}
          {!results.length && <p>{loading ? "Searching…" : "No matching resources in the available inventory"}</p>}
        </div>
        {hasMore && (
          <button
            type="button"
            disabled={limit >= 1000}
            onClick={() => setLimit((value) => Math.min(1000, value + 100))}
          >
            Show more matches
          </button>
        )}
        <details>
          <summary>Search options</summary>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              aria-label="Known namespace for restricted access"
              placeholder="Known namespace"
              value={knownNamespace}
              maxLength={63}
              onChange={(event) => setKnownNamespace(event.target.value)}
            />
            <button
              type="button"
              disabled={!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(knownNamespace)}
              onClick={() => {
                extraNamespaces.add(knownNamespace);
                restartSearchSync();
              }}
            >
              Index namespace
            </button>
          </div>
          {hasMore && limit >= 1000 && (
            <p>Showing up to 1000 candidates. Refine the name, type or namespace to continue.</p>
          )}
          {!coverage.storageFull && (
            <button type="button" onClick={clearCache}>
              Clear local search cache
            </button>
          )}
        </details>
        <p className="power-resource-search-shortcuts">↑↓ Navigate · Enter Open · Esc Close</p>
      </div>
    </div>
  );
}

let currentCoverage: SearchCoverage = {
  scanned: 0,
  discovered: 0,
  denied: 0,
  unavailable: 0,
  unsupported: 0,
  indexing: true,
};
let restartSearchSync = () => {};
const extraNamespaces = new Set<string>();

export function startResourceSearch(): () => void {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  let stop = preferences.resourceSearchEnabled ? startEnabledResourceSearch() : undefined;
  const dispose = reaction(
    () => preferences.resourceSearchEnabled,
    (enabled) => {
      stop?.();
      stop = enabled ? startEnabledResourceSearch() : undefined;
    },
  );
  return () => {
    dispose();
    stop?.();
    stop = undefined;
  };
}

function startEnabledResourceSearch(): () => void {
  let syncAbort: AbortController | undefined;
  const sync = () => {
    syncAbort?.abort();
    closeSearchResourceFallback();
    const clusterId = activeId();
    if (!clusterId || window.top === window) return;
    const phase = Renderer.Catalog.activeCluster.get()?.status?.phase;
    if (phase && phase !== "connected") {
      currentCoverage = {
        ...currentCoverage,
        indexing: false,
        message: "Cluster disconnected; cached results may be stale",
      };
      window.dispatchEvent(new Event("power-search-coverage"));
      return;
    }
    const controller = new AbortController();
    syncAbort = controller;
    const client = createResourceSearchClient(clusterId, searchContextId());
    const liveStores = new Map(inventory().map(([kind, store]) => [kind as string, store]));
    const liveObjects = new Map<string, Map<string, unknown>>();
    const sink = {
      ...client,
      append: (scope: string, scanId: string, documents: SearchDocument[]) =>
        client.append(
          scope,
          scanId,
          documents.map((item) => {
            const store = liveStores.get(item.kind);
            if (!store) return item;
            let objects = liveObjects.get(item.kind);
            if (!objects) {
              objects = new Map(store.items.map((object) => [object.selfLink, object] as const));
              liveObjects.set(item.kind, objects);
            }
            const object = objects.get(item.path);
            return object ? { ...item, fields: projectSearchFields(item.kind, object) } : item;
          }),
        ),
    };
    let wasIndexing = false;
    const task = createSearchSynchronizer({
      transport: createResourceSearchTransport(clusterId, controller.signal),
      sink,
      signal: controller.signal,
      namespaces: () => [
        ...new Set([...(Renderer.Catalog.activeCluster.get()?.spec?.accessibleNamespaces ?? []), ...extraNamespaces]),
      ],
      onStatus: (status) => {
        if (!controller.signal.aborted) {
          if (status.indexing && !wasIndexing) liveObjects.clear();
          wasIndexing = status.indexing;
          currentCoverage = status;
          window.dispatchEvent(new Event("power-search-coverage"));
        }
      },
    });
    void task.run().catch(() => {
      if (!controller.signal.aborted) {
        currentCoverage = { ...currentCoverage, indexing: false, unavailable: currentCoverage.unavailable + 1 };
        window.dispatchEvent(new Event("power-search-coverage"));
      }
    });
  };
  restartSearchSync = sync;
  sync();
  const container = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = `.power-resource-search-backdrop{position:fixed;inset:0;z-index:10000;background:#0007;display:flex;align-items:flex-start;justify-content:center;padding:8vh 20px}.power-resource-search-dialog{width:680px;max-width:100%;max-height:75vh;display:flex;flex-direction:column;padding:20px;gap:12px;background:var(--mainBackground,#222);color:var(--textColorPrimary,#eee);border:1px solid var(--borderColor,#555);border-radius:8px;box-shadow:0 16px 60px #0008}.power-resource-search-heading{display:flex;align-items:center;justify-content:space-between}.power-resource-search-filters input{flex:1;min-width:180px}.power-resource-search-dialog input{padding:12px;font-size:16px;background:var(--inputControlBackground,#333);color:inherit;border:1px solid var(--borderColor,#666);border-radius:4px}.power-resource-search-dialog p{margin:0;font-size:12px;color:var(--textColorSecondary,#bbb)}.power-resource-search-results{overflow:auto;min-height:180px;flex:1}.power-resource-search-row{display:flex;align-items:center;gap:12px;padding:4px;border-radius:4px}.power-resource-search-row{border-left:3px solid transparent}.power-resource-search-row.selected{background:var(--tableSelectedBackground,#394b66);border-left-color:var(--primary,#668fff)}.power-resource-search-row.selected .Icon{color:var(--primary,#8daaff)}.power-resource-search-row:hover{background:var(--tableHoveredBackground,#ffffff0b)}.power-resource-search-dialog button:hover:not(:disabled){background:#ffffff12;border-radius:4px}.power-resource-search-row>button:last-child{border:1px solid var(--borderColor,#555);border-radius:4px}.power-resource-search-shortcuts{padding-top:8px;border-top:1px solid var(--borderColor,#555)}.power-resource-search-dialog button{min-width:32px;min-height:32px;padding:6px;color:inherit;background:transparent;border:0;cursor:pointer}.power-resource-search-dialog button:disabled{opacity:.45;cursor:default}.power-resource-search-open{display:flex;align-items:center;gap:12px;flex:1;text-align:left;min-width:0}.power-resource-search-open span{min-width:0}.power-resource-search-open strong,.power-resource-search-open small{display:block;overflow-wrap:anywhere}.power-resource-search-open small{opacity:.7}.power-resource-search-row>button.power-resource-search-ai{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:34px;height:34px;min-width:34px;padding:0;background:var(--contentColor,#292d32);border:1px solid var(--borderColor,#666)}.power-resource-search-row.selected>button.power-resource-search-ai{background:var(--mainBackground,#202326);border-color:color-mix(in srgb,var(--textColorPrimary,#ddd) 55%,var(--borderColor,#666));box-shadow:0 1px 3px #0002}.power-resource-search-row.selected>button.power-resource-search-ai .Icon{color:var(--textColorAccent,#eee)}.power-resource-search-row>button.power-resource-search-ai:hover:not(:disabled){background:var(--contentColor,#30343a);border-color:var(--primary,#8daaff);color:var(--primary,#8daaff)}.power-resource-search-row>button.power-resource-search-ai:hover:not(:disabled) .Icon{color:inherit}.power-resource-search-dialog button:focus-visible{outline:2px solid var(--primary,#668fff)}`;
  document.head.append(style);
  document.body.append(container);
  let visible = false;
  const close = () => {
    if (visible) {
      visible = false;
      ReactDOM.unmountComponentAtNode(container);
    }
  };
  const show = () => {
    const clusterId = activeId();
    if (
      window.top === window ||
      !clusterId ||
      visible ||
      document.querySelector('[aria-modal="true"], .Dialog.is-opened')
    )
      return;
    visible = true;
    ReactDOM.render(<SearchDialog close={close} clusterId={clusterId} />, container);
  };
  let shift = createDoubleShift();
  const resetShift = () => {
    shift = createDoubleShift();
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing || event.key === "Process") {
      resetShift();
      return;
    }
    if (shift(event, performance.now())) show();
  };
  window.addEventListener("blur", resetShift);
  window.addEventListener("keydown", key);
  window.addEventListener("keyup", key);
  window.addEventListener(OPEN, show);
  const dispose = reaction(
    () => `${searchContextId()}/${Renderer.Catalog.activeCluster.get()?.status?.phase}`,
    () => {
      close();
      extraNamespaces.clear();
      sync();
    },
  );
  return () => {
    close();
    syncAbort?.abort();
    closeSearchResourceFallback();
    restartSearchSync = () => {};
    extraNamespaces.clear();
    dispose();
    window.removeEventListener("blur", resetShift);
    window.removeEventListener("keydown", key);
    window.removeEventListener("keyup", key);
    window.removeEventListener(OPEN, show);
    container.remove();
    style.remove();
  };
}
