import { Renderer } from "@freelensapp/extensions";
import { clipboard, ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "../common/date-time";
import {
  HELM_CHANNEL,
  type HelmOverview,
  type HelmReleaseMetadata,
  type HelmRequest,
  type HelmResponse,
  type HelmSection,
} from "../common/helm";
import { helmValuesValidationError } from "../common/helm-values-validation";
import { HelmPreferencesStore } from "../common/store/helm-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { HelmAppVersionCell } from "./helm-app-version";
import { HelmCodeView, HelmRevisionDiff } from "./helm-code-view";
import { useHelmVersionIndex } from "./helm-version-index";
import { NativeTooltip } from "./native-tooltip";

function ReleaseOverview({ overview, actions }: { overview: HelmOverview; actions: ReactNode }) {
  const fields = [
    ["Name", overview.name],
    ["Namespace", overview.namespace],
    ["Revision", overview.revision],
    ["Status", overview.status],
    ["Chart", overview.chartName || overview.chart],
    ["App version", overview.appVersion],
    ["Chart version", overview.chartVersion],
    ["Updated", overview.updatedAt],
    ["Description", overview.description],
  ] as const;
  return (
    <section className="helm-overview-card" aria-label="Release details">
      <header>
        <h3>Release details</h3>
        {actions}
      </header>
      <dl className="helm-overview">
        {fields
          .filter(([, value]) => value !== undefined && value !== "")
          .map(([label, value]) => (
            <div key={label} className={label === "Description" ? "helm-overview-description" : undefined}>
              <dt>{label}</dt>
              <dd>
                {label === "Status" ? (
                  <StatusBadge status={String(value)} />
                ) : label === "Updated" ? (
                  formatDateTime(String(value))
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <div className="helm-inline-alert" role="alert">
      <Icon material="error_outline" size={18} />
      <span>{children}</span>
    </div>
  );
}

function VersionSearchProgress({
  index,
  paused,
  onToggle,
  onRefresh,
}: {
  index: ReturnType<typeof useHelmVersionIndex>;
  paused: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  if (!index.total) return null;
  return (
    <div className="helm-version-progress" aria-label="App version search progress">
      <Icon
        material={
          index.errors || index.truncated
            ? "info_outline"
            : index.completed >= index.total
              ? "check_circle"
              : paused
                ? "pause_circle_outline"
                : "search"
        }
        size={16}
      />
      <span>
        App versions checked: {index.completed} / {index.total}
        {paused && index.completed < index.total ? " · Paused" : ""}
      </span>
      <progress aria-label="App versions checked" value={index.completed} max={index.total} />
      {index.completed < index.total && <Button label={paused ? "Resume" : "Stop"} onClick={onToggle} />}
      {index.errors > 0 && <small className="helm-version-unavailable">{index.errors} unavailable</small>}
      {index.truncated && (
        <small className="helm-version-unavailable">Only the first {index.total} entries are checked</small>
      )}
      {(index.errors > 0 || index.truncated) && <Button label="Refresh versions" onClick={onRefresh} />}
    </div>
  );
}

function validateDraft(value: string) {
  if (new TextEncoder().encode(value).length > 1024 * 1024) return "Values must be smaller than 1 MiB";
  return helmValuesValidationError(value);
}

let requestSequence = 0;
const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const cache = new Map<string, { result: HelmResponse; expiresAt: number }>();
function cachedMetadata(key?: string) {
  for (const [entry, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(entry);
  return key ? cache.get(key)?.result : undefined;
}
function responseError(response: Extract<HelmResponse, { ok: false }>) {
  return Object.assign(new Error(response.error.message), { code: response.error.code });
}
function invalidatesPartition(error: unknown) {
  return error instanceof Error && "code" in error && ["forbidden", "context-changed"].includes(String(error.code));
}
const invalidationListeners = new Set<(clusterId: string, error: Error) => void>();
const { Button, Checkbox, Icon, Menu, MenuItem, Select } = Renderer.Component;

function statusLabel(status: string) {
  const label = status.replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function StatusBadge({ status }: { status: string }) {
  return (
    <span className="helm-status" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}

export function useHelmRequest(request: Omit<HelmRequest, "requestId">, cacheKey?: string, generation = 0) {
  const identity = `${JSON.stringify(request)}/${generation}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const [state, setState] = useState<{
    result?: HelmResponse;
    loading: boolean;
    error?: string;
    errorCode?: string;
    stale?: boolean;
  }>({
    result: cachedMetadata(cacheKey),
    loading: true,
    stale: true,
  });
  const [attempt, setAttempt] = useState(0);
  const cancelRef = useRef<() => void>();
  useEffect(() => {
    let current = true;
    const payload: HelmRequest = { ...request, requestId: `${session}-${++requestSequence}`, refresh: attempt > 0 };
    const cancel = () => {
      if (!current) return;
      current = false;
      void ipcRenderer.invoke(HELM_CHANNEL, { ...payload, operation: "cancel" }).catch(() => undefined);
      setState((previous) => ({ ...previous, loading: false, stale: true }));
    };
    const invalidate = (clusterId: string, error: Error) => {
      if (clusterId !== request.clusterId || activeIdentity.current !== identity) return;
      cancel();
      setState({
        loading: false,
        stale: true,
        error: error.message,
        errorCode: "code" in error ? String(error.code) : undefined,
      });
    };
    invalidationListeners.add(invalidate);
    cancelRef.current = cancel;
    setState((previous) => ({ ...previous, loading: true, error: undefined, stale: true }));
    void ipcRenderer
      .invoke(HELM_CHANNEL, payload)
      .then((result: HelmResponse) => {
        if (!current || activeIdentity.current !== identity) return;
        if (!result.ok) throw responseError(result);
        if (cacheKey && request.operation === "list") {
          cache.delete(cacheKey);
          cache.set(cacheKey, { result, expiresAt: Date.now() + 30_000 });
          while (cache.size > 8) cache.delete(cache.keys().next().value as string);
        }
        setState({ result, loading: false, stale: false });
      })
      .catch((error: unknown) => {
        if (!current || activeIdentity.current !== identity) return;
        if (invalidatesPartition(error)) {
          cache.clear();
          for (const listener of invalidationListeners) listener(request.clusterId, error as Error);
        }
        if (current)
          setState((previous) => ({
            ...previous,
            result: invalidatesPartition(error) ? undefined : previous.result,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof Error && "code" in error ? String(error.code) : undefined,
          }));
      });
    return () => {
      invalidationListeners.delete(invalidate);
      cancel();
    };
  }, [identity, attempt, cacheKey]);
  return { ...state, refresh: () => setAttempt((value) => value + 1), cancel: () => cancelRef.current?.() };
}

function RequestStatus({
  state,
  refreshLabel = "Refresh",
}: {
  state: ReturnType<typeof useHelmRequest>;
  refreshLabel?: string;
}) {
  return (
    <div role="status" className="helm-request-status">
      {state.loading && (
        <>
          <span className="helm-loading">
            <span aria-hidden="true" className="helm-spinner">
              <Icon material="autorenew" />
            </span>
            Loading…
          </span>
          <Button label="Cancel" onClick={state.cancel} />
        </>
      )}
      {state.error && (
        <>
          <span role="alert" className="helm-error">
            <Icon material="error_outline" size={16} />
            {state.error}
          </span>
          <Button label="Retry" onClick={state.refresh} />
        </>
      )}
      {!state.loading && !state.error && (
        <NativeTooltip title={refreshLabel}>
          <button type="button" className="helm-icon-button" aria-label={refreshLabel} onClick={state.refresh}>
            <Icon material="refresh" size={18} />
            <span className="helm-sr-only">{refreshLabel}</span>
          </button>
        </NativeTooltip>
      )}
      {state.result?.ok && state.result.fetchedAt && (
        <small>
          {state.stale || state.loading || state.error || state.result.cached ? "Cached · " : "Updated · "}
          {formatDateTime(state.result.fetchedAt)}
        </small>
      )}
    </div>
  );
}

function Section({
  clusterId,
  contextId,
  release,
  tab,
  currentRelease,
  onChanged,
  deployedRelease,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  tab: HelmSection;
  currentRelease: HelmReleaseMetadata;
  deployedRelease?: HelmReleaseMetadata;
  onChanged: () => void;
}) {
  const state = useHelmRequest({
    clusterId,
    namespace: release.namespace,
    contextId,
    operation: "details",
    name: release.name,
    revision: release.revision,
    uid: release.uid,
    section: tab,
  });
  const [compare, setCompare] = useState(false);
  const [baseline, setBaseline] = useState("latest");
  const comparisonRelease = baseline === "deployed" && deployedRelease ? deployedRelease : currentRelease;
  const [editing, setEditing] = useState(false);
  const historical = release.revision !== currentRelease.revision;
  const detail = state.result?.ok ? state.result.detail : undefined;
  const lineCount = useMemo(() => {
    const content = detail?.content ?? "";
    let count = content ? 1 : 0;
    for (let index = 0; index < content.length; index++) if (content.charCodeAt(index) === 10) count++;
    return count;
  }, [detail?.content]);
  return (
    <>
      {!(tab === "overview" && detail?.overview) && (!compare || state.loading || state.error || state.stale) && (
        <RequestStatus state={state} />
      )}
      {historical && (tab === "values" || tab === "manifest") && detail && (
        <div className="helm-toolbar">
          {compare && deployedRelease && (
            <label className="helm-filter helm-comparison-baseline">
              <span>Compare with</span>
              <Select
                aria-label="Comparison baseline"
                value={baseline}
                options={[
                  { value: "latest", label: `Latest · Revision ${currentRelease.revision}` },
                  { value: "deployed", label: `Last deployed · Revision ${deployedRelease.revision}` },
                ]}
                onChange={(option) => setBaseline(option?.value ?? "latest")}
              />
            </label>
          )}
          <Button
            label={compare ? "Show revision" : "Compare with current"}
            disabled={state.loading || Boolean(state.error) || state.stale}
            onClick={() => setCompare(!compare)}
          />
        </div>
      )}
      {tab === "values" && !historical && detail && !state.loading && !state.error && !state.stale && (
        <ValuesEditing
          release={release}
          clusterId={clusterId}
          contextId={contextId}
          content={detail.content}
          editing={editing}
          setEditing={setEditing}
          onChanged={() => {
            state.refresh();
            onChanged();
          }}
        />
      )}
      {!editing &&
        (compare &&
        detail &&
        !state.loading &&
        !state.error &&
        !state.stale &&
        (tab === "values" || tab === "manifest") ? (
          <RevisionComparison
            key={`${tab}/${release.revision}/${comparisonRelease.revision}/${comparisonRelease.uid ?? ""}`}
            clusterId={clusterId}
            contextId={contextId}
            release={comparisonRelease}
            selected={release}
            baselineLabel={baseline === "deployed" && deployedRelease ? "Last deployed" : "Latest"}
            section={tab}
            content={detail.content}
          />
        ) : (
          <>
            {detail && tab === "overview" && detail.overview && (
              <ReleaseOverview
                overview={detail.overview}
                actions={<RequestStatus state={state} refreshLabel="Refresh overview" />}
              />
            )}
            {detail && (tab !== "overview" || !detail.overview) && (
              <>
                <div className="helm-code-header">
                  <span>
                    {tab === "notes" ? "Release notes" : `${tab.charAt(0).toUpperCase() + tab.slice(1)} · YAML`}
                  </span>
                  <small>{lineCount} lines</small>
                  <Button label="Copy" onClick={() => clipboard.writeText(detail.content)} />
                </div>
                {tab === "notes" ? (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      fontFamily: "var(--font-monospace, monospace)",
                      userSelect: "text",
                    }}
                  >
                    <code>{detail.content}</code>
                  </pre>
                ) : (
                  <HelmCodeView value={detail.content} ariaLabel={`${tab} for revision ${release.revision}`} />
                )}
              </>
            )}
          </>
        ))}
    </>
  );
}

const ValuesEditing = observer(
  ({
    release,
    clusterId,
    contextId,
    content,
    editing,
    setEditing,
    onChanged,
  }: {
    release: HelmReleaseMetadata;
    clusterId: string;
    contextId?: string;
    content: string;
    editing: boolean;
    setEditing: (value: boolean) => void;
    onChanged: () => void;
  }) => {
    const allowed =
      !ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled &&
      PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled;
    useEffect(() => {
      if (!allowed) setEditing(false);
    }, [allowed, setEditing]);
    if (!allowed) return null;
    return editing ? (
      <ValuesEditor
        key={`${release.revision}/${contextId}`}
        release={release}
        clusterId={clusterId}
        contextId={contextId}
        content={content}
        onCancel={() => setEditing(false)}
        onChanged={onChanged}
      />
    ) : (
      <div className="helm-toolbar">
        <Button label="Edit values" onClick={() => setEditing(true)} />
      </div>
    );
  },
);

const ValuesEditor = observer(
  ({
    release,
    clusterId,
    contextId,
    content,
    onCancel,
    onChanged,
  }: {
    release: HelmReleaseMetadata;
    clusterId: string;
    contextId?: string;
    content: string;
    onCancel: () => void;
    onChanged: () => void;
  }) => {
    const state = useHelmRequest({
      clusterId,
      contextId,
      namespace: release.namespace,
      name: release.name,
      revision: release.revision,
      uid: release.uid,
      operation: "edit-options",
    });
    const [draft, setDraft] = useState(content);
    const [chart, setChart] = useState("");
    const [busy, setBusy] = useState(false);
    const [attempted, setAttempted] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const live = useRef(true);
    const operation = useRef<HelmRequest>();
    const choices = state.result?.ok ? (state.result.chartChoices ?? []) : [];
    const selectedChart = chart || choices[0]?.ref || "";
    const permitted = Boolean(
      state.result?.ok &&
        state.result.upgradeAllowed &&
        !state.loading &&
        !state.stale &&
        !state.error &&
        !ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled &&
        PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled,
    );
    const [validation, setValidation] = useState(() => ({ draft: content, error: validateDraft(content) }));
    const validationPending = validation.draft !== draft;
    useEffect(() => {
      if (!validationPending) return;
      const timer = setTimeout(() => setValidation({ draft, error: validateDraft(draft) }), 150);
      return () => clearTimeout(timer);
    }, [draft, validationPending]);
    const validationError = validationPending ? undefined : validation.error;
    const ready =
      permitted &&
      !validationPending &&
      !validationError &&
      draft !== content &&
      choices.some((choice) => choice.ref === selectedChart) &&
      !attempted &&
      !busy;
    const latest = useRef({ ready, draft, selectedChart });
    latest.current = { ready, draft, selectedChart };
    useEffect(
      () => () => {
        live.current = false;
        if (operation.current)
          void ipcRenderer.invoke(HELM_CHANNEL, { ...operation.current, operation: "cancel" }).catch(() => undefined);
      },
      [],
    );
    const save = () => {
      if (!ready) return;
      const values = draft;
      const chartRef = selectedChart;
      Renderer.Component.ConfirmDialog.open({
        message: (
          <div className="power-helm-confirmation">
            <div className="helm-confirmation-heading">
              <strong>Apply values to {release.name}?</strong>
              <p>
                This upgrades the current release using the same chart version. Review your changes before applying.
              </p>
            </div>
            <HelmRevisionDiff
              before={content}
              after={values}
              beforeLabel={
                <>
                  <span>Current · Revision {release.revision}</span>
                  <StatusBadge status={release.status} />
                </>
              }
              afterLabel="Proposed values"
            />
          </div>
        ),
        labelOk: "Apply values",
        okButtonProps: { className: "power-helm-confirm" },
        ok: () => {
          if (
            !live.current ||
            operation.current ||
            !latest.current.ready ||
            latest.current.draft !== values ||
            latest.current.selectedChart !== chartRef ||
            ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled ||
            !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled
          )
            return;
          const payload: HelmRequest = {
            operation: "upgrade-values",
            requestId: `${session}-${++requestSequence}`,
            clusterId,
            contextId: state.result?.ok ? (state.result.contextId ?? contextId) : contextId,
            namespace: release.namespace,
            name: release.name,
            revision: release.revision,
            uid: release.uid,
            chart: chartRef,
            values,
            confirmed: true,
          };
          operation.current = payload;
          setBusy(true);
          setAttempted(true);
          setError("");
          void ipcRenderer
            .invoke(HELM_CHANNEL, payload)
            .then((response: HelmResponse) => {
              if (!live.current) return;
              if (!response.ok) throw responseError(response);
              onChanged();
              onCancel();
            })
            .catch((failure: unknown) => {
              if (live.current) {
                setError(failure instanceof Error ? failure.message : String(failure));
                if (
                  failure instanceof Error &&
                  "code" in failure &&
                  ["invalid-values", "invalid-request", "chart-unavailable"].includes(String(failure.code))
                )
                  setAttempted(false);
              }
            })
            .finally(() => {
              operation.current = undefined;
              if (live.current) setBusy(false);
            });
        },
      });
    };
    const refreshRelease = () => {
      if (
        !live.current ||
        operation.current ||
        busy ||
        ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled ||
        !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled
      )
        return;
      const trustedContextId = state.result?.ok ? (state.result.contextId ?? contextId) : contextId;
      const payload: HelmRequest = {
        operation: "history",
        requestId: `${session}-${++requestSequence}`,
        clusterId,
        namespace: release.namespace,
        name: release.name,
        contextId: trustedContextId,
        refresh: true,
      };
      operation.current = payload;
      setBusy(true);
      setRefreshing(true);
      void ipcRenderer
        .invoke(HELM_CHANNEL, payload)
        .then((response: HelmResponse) => {
          if (!live.current) return;
          if (!response.ok) throw responseError(response);
          if (trustedContextId && response.contextId && response.contextId !== trustedContextId)
            throw new Error("The cluster context changed. Reopen the release before editing values.");
          if (
            ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled ||
            !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled
          )
            return;
          setError("");
          setAttempted(false);
          state.refresh();
          onChanged();
          onCancel();
        })
        .catch((failure: unknown) => {
          if (live.current) setError(failure instanceof Error ? failure.message : String(failure));
        })
        .finally(() => {
          operation.current = undefined;
          if (live.current) {
            setBusy(false);
            setRefreshing(false);
          }
        });
    };
    return (
      <div className="helm-values-editor">
        <div className="helm-edit-notice">
          <Icon material="edit" size={16} />
          <div>
            <strong>Edit current values</strong>
            <p>Applying creates a new release revision. The chart version stays unchanged.</p>
          </div>
        </div>
        <RequestStatus state={state} />
        {!state.loading && !state.error && !choices.length && (
          <p role="alert">
            No matching chart is available in your Helm repositories. Add the repository for this chart before editing
            values.
          </p>
        )}
        {choices.length > 0 && (
          <label className="helm-filter">
            <span>Chart source · same version</span>
            <Select
              aria-label="Chart source"
              value={selectedChart}
              options={choices.map((choice) => ({ value: choice.ref, label: `${choice.ref} · ${choice.version}` }))}
              onChange={(option) => setChart(option?.value ?? "")}
            />
          </label>
        )}
        <HelmCodeView
          value={draft}
          readOnly={busy || attempted || !permitted}
          onChange={(value) => {
            setDraft(value);
            setError("");
          }}
          ariaLabel="Edit current release values"
        />
        {validationPending && (
          <small className="helm-validation-pending" role="status">
            Checking YAML…
          </small>
        )}
        {validationError && <InlineAlert>{validationError}</InlineAlert>}
        {error && <InlineAlert>{error}</InlineAlert>}
        <div className="helm-toolbar">
          <Button
            label={refreshing ? "Refreshing…" : busy ? "Applying…" : "Review changes"}
            disabled={!ready}
            onClick={save}
          />
          <Button label="Cancel editing" disabled={busy} onClick={onCancel} />
          {attempted && !busy && <Button label="Refresh release" onClick={refreshRelease} />}
        </div>
      </div>
    );
  },
);

function RevisionComparison({
  clusterId,
  contextId,
  release,
  selected,
  section,
  content,
  baselineLabel,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  selected: HelmReleaseMetadata;
  section: HelmSection;
  content: string;
  baselineLabel: string;
}) {
  const state = useHelmRequest({
    clusterId,
    contextId,
    namespace: release.namespace,
    operation: "details",
    name: release.name,
    revision: release.revision,
    uid: release.uid,
    section,
  });
  const current = state.result?.ok ? state.result.detail : undefined;
  return (
    <>
      <RequestStatus state={state} />
      {!state.loading && !state.error && !state.stale && current && (
        <HelmRevisionDiff
          before={content}
          after={current.content}
          beforeLabel={
            <>
              <span>Revision {selected.revision}</span>
              <StatusBadge status={selected.status} />
            </>
          }
          afterLabel={
            <>
              <span>
                {baselineLabel} · Revision {release.revision}
              </span>
              <StatusBadge status={release.status} />
            </>
          }
        />
      )}
    </>
  );
}

const History = observer(
  ({
    clusterId,
    contextId,
    release,
    onChanged,
    onView,
    onLatest,
    onDeployed,
    generation,
  }: {
    clusterId: string;
    contextId?: string;
    release: HelmReleaseMetadata;
    onChanged: () => void;
    onView: (revision: HelmReleaseMetadata) => void;
    onLatest: (revision: HelmReleaseMetadata) => void;
    onDeployed: (revision: HelmReleaseMetadata | undefined) => void;
    generation: number;
  }) => {
    const state = useHelmRequest(
      {
        clusterId,
        contextId,
        namespace: release.namespace,
        operation: "history",
        name: release.name,
      },
      undefined,
      generation,
    );
    const [revision, setRevision] = useState<number>();
    const [versionGeneration, setVersionGeneration] = useState(0);
    const [revisionFilter, setRevisionFilter] = useState("");
    const [page, setPage] = useState(0);
    const historyFrame = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (historyFrame.current) historyFrame.current.scrollTop = 0;
    }, [page, revisionFilter, state.result]);
    useEffect(() => setPage(0), [state.result, revisionFilter]);
    const [versionsPaused, setVersionsPaused] = useState(false);
    const versionIndex = useHelmVersionIndex({
      clusterId,
      contextId: contextId ?? "",
      releases: state.result?.ok ? (state.result.releases ?? []) : [],
      active: Boolean(
        contextId && state.result?.ok && !state.loading && !state.error && !state.stale && !versionsPaused,
      ),
      refreshToken: versionGeneration,
    });
    const history = state.result?.ok
      ? (state.result.releases ?? []).filter(
          (item) =>
            !revisionFilter ||
            String(item.revision) === revisionFilter ||
            (versionIndex.versionFor(item)?.appVersion ?? "").toLowerCase().includes(revisionFilter.toLowerCase()),
        )
      : [];
    const historyPage = history.slice(page * 50, (page + 1) * 50);
    useEffect(() => {
      if (
        !state.result?.ok ||
        state.loading ||
        state.error ||
        state.stale ||
        (contextId && state.result.contextId && contextId !== state.result.contextId)
      )
        return;
      const latest = (state.result.releases ?? [])
        .filter((item) => item.name === release.name && item.namespace === release.namespace)
        .reduce<HelmReleaseMetadata | undefined>(
          (highest, item) => (!highest || item.revision > highest.revision ? item : highest),
          undefined,
        );
      if (latest) onLatest(latest);
      const deployed = (state.result.releases ?? [])
        .filter(
          (item) => item.name === release.name && item.namespace === release.namespace && item.status === "deployed",
        )
        .reduce<HelmReleaseMetadata | undefined>(
          (highest, item) => (!highest || item.revision > highest.revision ? item : highest),
          undefined,
        );
      onDeployed(deployed);
    }, [state.result, state.loading, state.error, state.stale]);
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => setConfirmed(false), [state.result, generation]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const live = useRef(true);
    const operation = useRef<HelmRequest>();
    useEffect(
      () => () => {
        live.current = false;
        if (operation.current)
          void ipcRenderer.invoke(HELM_CHANNEL, { ...operation.current, operation: "cancel" }).catch(() => undefined);
      },
      [],
    );
    const readOnly = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled;
    const allowed =
      state.result?.ok &&
      state.result.rollbackAllowed &&
      !readOnly &&
      PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled;
    useEffect(() => {
      if (!allowed) {
        setConfirmed(false);
        setRevision(undefined);
      }
    }, [allowed]);
    const historyCurrent = !state.loading && !state.error && !state.stale;
    const eligible = useRef(false);
    eligible.current = Boolean(allowed && historyCurrent);
    const target = state.result?.ok ? state.result.releases?.find((item) => item.revision === revision) : undefined;
    const consent = useRef({ revision, confirmed, uid: target?.uid });
    consent.current = { revision, confirmed, uid: target?.uid };
    const rollback = () => {
      if (!allowed || !historyCurrent || !confirmed || !revision || !target || busy) return;
      const targetUid = target.uid;
      Renderer.Component.ConfirmDialog.open({
        message: (
          <div className="power-helm-confirmation helm-rollback-confirmation">
            <strong>Roll back {release.name}?</strong>
            <p>
              Restore this release in <strong>{release.namespace}</strong> to revision
            </p>
            <div className="helm-confirmation-target">
              <Icon material="restore" size={18} />
              <span className="helm-revision-badge" aria-label={`Target revision ${revision}`}>
                {revision}
              </span>
              <StatusBadge status={target.status} />
              <span className="helm-target-version">
                App version{" "}
                {contextId ? (
                  <HelmAppVersionCell
                    clusterId={clusterId}
                    contextId={contextId}
                    release={target}
                    knownVersion={versionIndex.versionFor(target)}
                    refreshToken={versionGeneration}
                  />
                ) : (
                  "—"
                )}
              </span>
            </div>
            <p className="helm-confirmation-explanation">
              Rolling back creates a new revision. Existing history is preserved.
            </p>
          </div>
        ),
        labelOk: `Roll back to revision ${revision}`,
        okButtonProps: { className: "power-helm-confirm" },
        ok: () => {
          if (
            !live.current ||
            !eligible.current ||
            !consent.current.confirmed ||
            consent.current.revision !== revision ||
            consent.current.uid !== targetUid ||
            operation.current ||
            ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled ||
            !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled
          )
            return;
          const payload: HelmRequest = {
            operation: "rollback",
            requestId: `${session}-${++requestSequence}`,
            clusterId,
            namespace: release.namespace,
            name: release.name,
            revision,
            uid: targetUid,
            confirmed: true,
            contextId: state.result?.ok ? (state.result.contextId ?? contextId) : contextId,
          };
          operation.current = payload;
          setBusy(true);
          setError("");
          void ipcRenderer
            .invoke(HELM_CHANNEL, payload)
            .then((result: HelmResponse) => {
              if (!live.current) return;
              if (!result.ok) throw responseError(result);
            })
            .catch((failure: unknown) => {
              if (live.current) setError(failure instanceof Error ? failure.message : String(failure));
            })
            .finally(() => {
              operation.current = undefined;
              if (live.current) {
                setBusy(false);
                setConfirmed(false);
                setRevision(undefined);
                state.refresh();
                onChanged();
              }
            });
        },
      });
    };
    return (
      <div className="helm-history-layout">
        <RequestStatus
          state={{
            ...state,
            refresh: () => {
              setVersionGeneration((value) => value + 1);
              state.refresh();
            },
          }}
        />
        {state.result?.ok && (
          <div className="helm-toolbar">
            <input
              className="helm-text-input"
              aria-label="Search revision history"
              placeholder="Revision or App version"
              value={revisionFilter}
              onChange={(event) => setRevisionFilter(event.target.value)}
            />
            <small>
              {history.length} revisions{revision ? ` · Selected revision ${revision}` : ""}
            </small>
            {readOnly && (
              <NativeTooltip title="Read-only mode is enabled. Revision contents and comparisons remain available">
                <span className="helm-access-badge" role="status" aria-label="Read only">
                  <Icon material="lock_outline" size={14} />
                  Read only
                </span>
              </NativeTooltip>
            )}
          </div>
        )}
        {revisionFilter && (
          <VersionSearchProgress
            index={versionIndex}
            paused={versionsPaused}
            onToggle={() => setVersionsPaused((value) => !value)}
            onRefresh={() => {
              setVersionsPaused(false);
              setVersionGeneration((value) => value + 1);
            }}
          />
        )}
        {state.result?.ok && (
          <div
            ref={historyFrame}
            className="helm-history-frame"
            role="region"
            aria-label="Revision history table"
            tabIndex={0}
          >
            <table className="helm-table helm-history-table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>App version</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>
                    <span className="helm-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!history.length && (
                  <tr>
                    <td colSpan={5} className="helm-history-empty">
                      {versionIndex.completed < versionIndex.total || versionIndex.errors > 0 || versionIndex.truncated
                        ? "No known matches yet"
                        : "No matching revisions"}
                    </td>
                  </tr>
                )}
                {historyPage.map((item) => (
                  <tr key={item.revision} data-selected={revision === item.revision}>
                    <td>
                      {allowed ? (
                        <label>
                          <input
                            aria-label={`Revision ${item.revision}`}
                            type="radio"
                            name="helm-revision"
                            checked={revision === item.revision}
                            disabled={busy || !historyCurrent}
                            onChange={() => {
                              setRevision(item.revision);
                              setConfirmed(false);
                            }}
                          />{" "}
                          {item.revision}
                        </label>
                      ) : (
                        <span aria-label={`Revision ${item.revision}`}>{item.revision}</span>
                      )}
                      {item.revision === release.revision && <span className="helm-current-tag">Current</span>}
                    </td>
                    <td>
                      {contextId ? (
                        <HelmAppVersionCell
                          clusterId={clusterId}
                          contextId={contextId}
                          release={item}
                          knownVersion={versionIndex.versionFor(item)}
                          active={historyCurrent && !busy}
                          refreshToken={versionGeneration}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td>{item.updatedAt ? formatDateTime(item.updatedAt) : "—"}</td>
                    <td>
                      <Button
                        className="helm-inline-action"
                        label="View revision"
                        disabled={!historyCurrent || busy}
                        onClick={() => onView(item)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.length > 50 && (
          <div className="helm-toolbar">
            <Button label="Previous revisions" disabled={page === 0} onClick={() => setPage((value) => value - 1)} />
            <span>
              Page {page + 1} of {Math.ceil(history.length / 50)}
            </span>
            <Button
              label="Next revisions"
              disabled={(page + 1) * 50 >= history.length}
              onClick={() => setPage((value) => value + 1)}
            />
          </div>
        )}
        {allowed && (
          <>
            <div className="helm-rollback">
              <div className="helm-rollback-title">
                <Icon material="restore" size={18} />
                Roll back release
              </div>
              {!revision && <p>Select a revision to restore this release.</p>}
              <div className="helm-rollback-controls">
                <Checkbox
                  className="helm-consent"
                  label={
                    <span className="helm-consent-target">
                      I confirm rolling back <strong>{release.name}</strong>
                      {target && (
                        <>
                          {" "}
                          to <span className="helm-consent-revision">revision {target.revision}</span>
                          <span className="helm-consent-version">
                            App version {versionIndex.versionFor(target)?.appVersion ?? "—"}
                          </span>
                        </>
                      )}
                    </span>
                  }
                  value={confirmed}
                  disabled={busy || !revision || !historyCurrent}
                  onChange={(value) => setConfirmed(value)}
                />
                <Button
                  label={busy ? "Rolling back…" : "Roll back"}
                  disabled={!revision || !confirmed || busy || !historyCurrent}
                  onClick={rollback}
                />
              </div>
            </div>
          </>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
      </div>
    );
  },
);

function ReleasePanel({
  clusterId,
  contextId,
  release,
  close,
  onChanged,
  onLatest,
  historyGeneration,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  close: () => void;
  onChanged: () => void;
  onLatest: (revision: HelmReleaseMetadata) => void;
  historyGeneration: number;
}) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const overlayEscapes = useRef(new WeakSet<KeyboardEvent>());
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const closeButton = useRef<HTMLButtonElement>(null);
  const latestClose = useRef(close);
  latestClose.current = close;
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
    const captureEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        document.querySelector('[data-testid="confirmation-dialog"], .Select__menu, .helm-release-actions-menu')
      )
        overlayEscapes.current.add(event);
    };
    window.addEventListener("keydown", captureEscape, true);
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        overlayEscapes.current.has(event) ||
        document.querySelector('[data-testid="confirmation-dialog"], .Select__menu, .helm-release-actions-menu')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", captureEscape, true);
      document.removeEventListener("keydown", onEscape);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus({ preventScroll: true });
  };
  const [tab, setTab] = useState<HelmSection | "history">("overview");
  const [deployedRelease, setDeployedRelease] = useState<HelmReleaseMetadata>();
  useEffect(() => setDeployedRelease(undefined), [historyGeneration]);
  const [historicalRelease, setHistoricalRelease] = useState<HelmReleaseMetadata>();
  useEffect(() => setHistoricalRelease(undefined), [release.revision, release.uid]);
  const viewedRelease = historicalRelease ?? release;
  return (
    <aside aria-label={`Release ${release.name}`} className="helm-panel">
      <div className="helm-panel-heading">
        <div>
          <h2>{release.name}</h2>
          <div className="helm-panel-meta">
            <span>{release.namespace}</span>
            <span>
              {historicalRelease ? "Viewing revision" : "Revision"} {viewedRelease.revision}
            </span>
            <StatusBadge status={viewedRelease.status} />
          </div>
        </div>
        <div className="helm-panel-actions">
          <NativeTooltip title={menuOpen ? undefined : "Release actions"}>
            <button
              ref={menuButton}
              type="button"
              className="helm-icon-button"
              aria-label="Release actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon material="more_vert" size={20} />
            </button>
          </NativeTooltip>
          {menuOpen && (
            <Menu
              isOpen
              open={() => setMenuOpen(true)}
              close={closeMenu}
              contextTarget={menuButton.current}
              autoFocus
              usePortal
              className="helm-release-actions-menu"
            >
              <MenuItem
                onClick={() => {
                  setHistoricalRelease(undefined);
                  setTab("values");
                  closeMenu();
                }}
              >
                <Icon material="description" size={16} />
                Show values
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setHistoricalRelease(undefined);
                  setTab("history");
                  closeMenu();
                }}
              >
                <Icon material="history" size={16} />
                Show history
              </MenuItem>
              <MenuItem
                onClick={() => {
                  clipboard.writeText(release.name);
                  closeMenu();
                }}
              >
                <Icon material="content_copy" size={16} />
                Copy release name
              </MenuItem>
              <MenuItem
                onClick={() => {
                  clipboard.writeText(release.namespace);
                  closeMenu();
                }}
              >
                <Icon material="content_copy" size={16} />
                Copy namespace
              </MenuItem>
            </Menu>
          )}
          <NativeTooltip title="Close (Esc)">
            <button ref={closeButton} type="button" className="helm-icon-button" aria-label="Close" onClick={close}>
              <Icon material="close" size={20} />
            </button>
          </NativeTooltip>
        </div>
      </div>
      {historicalRelease && (
        <div className="helm-viewing-banner">
          <span>
            Historical revision · Read only
            <small className="helm-current-baseline">Current revision {release.revision}</small>
          </span>
          <Button label="Back to current" onClick={() => setHistoricalRelease(undefined)} />
        </div>
      )}
      <nav className="helm-tabs">
        {(["overview", "values", "manifest", "notes", "history"] as const).map((value) => (
          <Button
            key={value}
            label={value[0].toUpperCase() + value.slice(1)}
            className={tab === value ? "helm-tab helm-tab-active" : "helm-tab"}
            onClick={() => {
              setTab(value);
              if (value === "history") setHistoricalRelease(undefined);
            }}
          />
        ))}
      </nav>
      <div className="helm-panel-content">
        {tab === "history" ? (
          <History
            generation={historyGeneration}
            clusterId={clusterId}
            contextId={contextId}
            release={release}
            onChanged={onChanged}
            onLatest={onLatest}
            onDeployed={setDeployedRelease}
            onView={(item) => {
              setHistoricalRelease(item.revision === release.revision ? undefined : item);
              setTab("values");
            }}
          />
        ) : (
          <Section
            key={`${tab}/${viewedRelease.revision}/${viewedRelease.uid ?? ""}`}
            clusterId={clusterId}
            contextId={contextId}
            release={viewedRelease}
            currentRelease={release}
            deployedRelease={deployedRelease}
            onChanged={onChanged}
            tab={tab}
          />
        )}
      </div>
    </aside>
  );
}

function Releases({
  clusterId,
  namespace,
  partition,
  namespaceFilter,
}: {
  clusterId: string;
  namespace: string;
  partition: string;
  namespaceFilter: ReactNode;
}) {
  const state = useHelmRequest({ clusterId, namespace, operation: "list" }, `${partition}/${namespace}`);
  const [search, setSearch] = useState("");
  const [versionGeneration, setVersionGeneration] = useState(0);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [search, status, state.result]);
  const [selection, setSelection] = useState<{
    release: HelmReleaseMetadata;
    result: Extract<HelmResponse, { ok: true }>;
  }>();
  const result = state.result?.ok ? state.result : undefined;
  const historyGeneration = useRef({ result, id: 0 });
  if (historyGeneration.current.result !== result)
    historyGeneration.current = { result, id: historyGeneration.current.id + 1 };
  const listedSelection =
    selection &&
    result?.releases?.find(
      (item) => item.name === selection.release.name && item.namespace === selection.release.namespace,
    );
  const selected =
    selection && result && selection.result.contextId === result.contextId
      ? selection.result === result
        ? selection.release
        : listedSelection
      : undefined;
  useEffect(() => {
    if (state.errorCode === "forbidden" || state.errorCode === "context-changed") {
      setSelection(undefined);
      return;
    }
    if (!selection || !result || selection.result === result) return;
    if (selection.result.contextId !== result.contextId || !listedSelection) setSelection(undefined);
    else setSelection({ release: listedSelection, result });
  }, [state.errorCode, selection, result, listedSelection]);
  const releases = (result?.releases ?? []).map((item) =>
    selected &&
    selected.name === item.name &&
    selected.namespace === item.namespace &&
    selected.revision > item.revision
      ? selected
      : item,
  );
  const selectedRelease = selected;
  const [versionsPaused, setVersionsPaused] = useState(false);
  useEffect(() => setVersionsPaused(false), [result?.contextId]);
  const versionIndex = useHelmVersionIndex({
    clusterId,
    contextId: result?.contextId ?? "",
    releases,
    active: Boolean(
      result?.contextId && !selectedRelease && !state.loading && !state.error && !state.stale && !versionsPaused,
    ),
    refreshToken: versionGeneration,
  });
  const filtered = releases.filter(
    (release) =>
      `${release.name} ${release.namespace} ${versionIndex.versionFor(release)?.appVersion ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!status || status === release.status),
  );
  return (
    <>
      <div className="helm-toolbar helm-filters">
        {namespaceFilter}
        <label className="helm-filter">
          <span>Search</span>
          <input
            className="helm-text-input"
            aria-label="Search releases"
            placeholder="Search releases"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="helm-filter helm-status-filter">
          <span>Status</span>
          <Select
            aria-label="Release status"
            value={status}
            formatOptionLabel={(option) =>
              option.value ? (
                <span className="helm-status-menu">
                  <StatusBadge status={String(option.value)} />
                </span>
              ) : (
                option.label
              )
            }
            options={[
              { value: "", label: "All statuses" },
              ...[...new Set(releases.map((release) => release.status))]
                .sort()
                .map((value) => ({ value, label: statusLabel(value) })),
            ]}
            onChange={(option) => setStatus(option?.value ?? "")}
          />
        </label>
      </div>
      <div className="helm-list-summary">
        <span>
          {filtered.length} {filtered.length === 1 ? "release" : "releases"}
        </span>
        <RequestStatus
          state={{
            ...state,
            refresh: () => {
              setVersionGeneration((value) => value + 1);
              state.refresh();
            },
          }}
        />
      </div>
      {search && (
        <VersionSearchProgress
          index={versionIndex}
          paused={versionsPaused}
          onToggle={() => setVersionsPaused((value) => !value)}
          onRefresh={() => {
            setVersionsPaused(false);
            setVersionGeneration((value) => value + 1);
          }}
        />
      )}
      {(filtered.length > 0 || state.loading || state.error) && (
        <div className="helm-table-frame" role="region" aria-label="Helm releases table" tabIndex={0}>
          <table className="helm-table">
            <thead>
              <tr>
                {["Name", "Namespace", "App version", "Revision", "Status", "Metadata updated"].map((title) => (
                  <th key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(page * 100, (page + 1) * 100).map((release) => (
                <tr key={`${release.namespace}/${release.name}`}>
                  <td>
                    <Button
                      className="helm-release-link"
                      label={release.name}
                      onClick={() => {
                        if (result) setSelection({ release, result });
                      }}
                    />
                  </td>
                  <td>{release.namespace}</td>
                  <td>
                    {result?.contextId ? (
                      <HelmAppVersionCell
                        clusterId={clusterId}
                        contextId={result.contextId}
                        release={release}
                        knownVersion={versionIndex.versionFor(release)}
                        active={!selectedRelease && !state.loading}
                        refreshToken={versionGeneration}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{release.revision}</td>
                  <td>
                    <StatusBadge status={release.status} />
                  </td>
                  <td>{release.updatedAt ? formatDateTime(release.updatedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 100 && (
        <div className="helm-toolbar">
          <Button label="Previous releases" disabled={page === 0} onClick={() => setPage((value) => value - 1)} />
          <span>
            {filtered.length} releases · Page {page + 1} of {Math.ceil(filtered.length / 100)}
          </span>
          <Button
            label="Next releases"
            disabled={(page + 1) * 100 >= filtered.length}
            onClick={() => setPage((value) => value + 1)}
          />
        </div>
      )}
      {!state.loading && !state.error && !filtered.length && (
        <div className="helm-empty">
          <Icon material="search" size={28} />
          <p>
            {search &&
            (versionIndex.completed < versionIndex.total || versionIndex.errors > 0 || versionIndex.truncated)
              ? "No known matches"
              : "No releases found"}
          </p>
          <span>
            {search &&
            (versionIndex.completed < versionIndex.total || versionIndex.errors > 0 || versionIndex.truncated)
              ? versionIndex.errors > 0 || versionIndex.truncated
                ? "Some App versions are unavailable. Refresh versions to check again"
                : versionsPaused
                  ? "Resume App version checks to find more matches"
                  : "More matches may appear as App versions are checked"
              : search || status
                ? "No releases match your filters"
                : "This namespace has no Helm releases"}
          </span>
          {(search || status) && (
            <Button
              label="Clear filters"
              onClick={() => {
                setSearch("");
                setStatus("");
              }}
            />
          )}
        </div>
      )}
      {selectedRelease && (
        <ReleasePanel
          key={`${selectedRelease.namespace}/${selectedRelease.name}/${state.result?.ok ? state.result.contextId : ""}`}
          clusterId={clusterId}
          contextId={state.result?.ok ? state.result.contextId : undefined}
          release={selectedRelease}
          close={() => setSelection(undefined)}
          onChanged={state.refresh}
          historyGeneration={historyGeneration.current.id}
          onLatest={(latest) =>
            setSelection((previous) =>
              previous &&
              result &&
              previous.result === result &&
              latest.name === previous.release.name &&
              latest.namespace === previous.release.namespace &&
              latest.revision > previous.release.revision
                ? { release: latest, result }
                : previous,
            )
          }
        />
      )}
    </>
  );
}

const ClusterHelm = observer(({ clusterId, partition }: { clusterId: string; partition: string }) => {
  const [namespace, setNamespace] = useState("");
  const namespaces =
    process.isMainFrame === false
      ? Renderer.K8sApi.namespaceStore.items.map((item) => item.getName())
      : (Renderer.Catalog.activeCluster.get()?.spec?.accessibleNamespaces ?? []);
  return (
    <Releases
      key={`${partition}/${namespace}`}
      clusterId={clusterId}
      namespace={namespace}
      partition={partition}
      namespaceFilter={
        <label className="helm-filter helm-namespace">
          <span>Namespace</span>
          <Select
            aria-label="Helm namespace"
            value={namespace}
            options={[{ value: "", label: "All namespaces" }, ...namespaces.map((value) => ({ value, label: value }))]}
            onChange={(option) => setNamespace(option?.value ?? "")}
          />
        </label>
      }
    />
  );
});

export const PowerHelmPage = observer(() => {
  const enabled = HelmPreferencesStore.getInstanceOrCreate<HelmPreferencesStore>().enabled;
  const cluster = Renderer.Catalog.activeCluster.get();
  const clusterId = cluster?.metadata.uid;
  const partition = JSON.stringify([clusterId, cluster?.spec]);
  return (
    <div
      className="power-helm"
      style={{
        position: "relative",
        height: "100%",
        minHeight: 0,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        padding: 20,
      }}
    >
      <style>{`
        .power-helm { color: var(--textColorPrimary); font-size: 13px; }
        .power-helm h2, .power-helm p { margin: 0; }
        .power-helm .helm-page-title { display: flex; align-items: center; gap: 12px; }
        .power-helm .helm-page-title > .Icon { width: 32px; height: 32px; }
        .power-helm h2 { font-size: 19px; font-weight: 600; line-height: 1.4; }
        .power-helm .helm-page-title span, .power-helm small, .power-helm .helm-filter > span, .power-helm .helm-panel-meta, .power-helm .helm-empty > span { color: var(--textColorSecondary); font-size: 12px; }
        .power-helm .helm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0; }
        .power-helm .helm-filter { display: flex; flex-direction: column; gap: 6px; min-width: 180px; }
        .power-helm .helm-namespace { width: 230px; }
        .power-helm .helm-filters { display: grid; grid-template-columns: 200px minmax(160px, 1fr) 160px; align-items: end; margin-top: 0; }
        .power-helm .helm-filters .helm-filter { width: auto; min-width: 0; max-width: none; }
        .power-helm .helm-filter .Select { width: 100%; min-width: 0; }
        .power-helm .helm-filter .Select__control { box-sizing: border-box; min-height: 32px; height: 32px; font-size: 12px; }
        .power-helm .helm-filter .Select__value-container { padding: 0 8px; }
        .power-helm .helm-filter .Select__input-container { margin: 0; padding: 0; }
        .power-helm .helm-filter .Select__indicator { padding: 4px 8px; }
        @media (max-width: 760px) { .power-helm .helm-filters { grid-template-columns: minmax(0, 1fr); } }
        .power-helm .helm-text-input { box-sizing: border-box; height: 32px; color: var(--textColorPrimary); background: var(--inputControlBackground, var(--mainBackground)); border: 1px solid var(--borderColor); border-radius: 4px; padding: 6px 10px; font: inherit; }
        .power-helm .helm-text-input:focus-visible, .power-helm input[type=radio]:focus-visible, .power-helm button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-helm input[type=checkbox], .power-helm input[type=radio] { accent-color: var(--primary); margin: 0 7px 0 0; vertical-align: middle; }
        .power-helm .helm-native-button, .power-helm .helm-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; color: var(--textColorSecondary); border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
        .power-helm .helm-native-button:hover, .power-helm .helm-icon-button:hover { color: var(--textColorPrimary); background: var(--contentColor); }
        .power-helm .helm-list-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; margin: 6px 0 10px; }
        .power-helm .helm-request-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 30px; }
        .power-helm .helm-panel-content > .helm-request-status { justify-content: flex-end; margin-bottom: 12px; }
        .power-helm .helm-loading, .power-helm .helm-error { display: inline-flex; gap: 6px; align-items: center; }
        .power-helm .helm-inline-alert { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--colorError) 30%, var(--borderColor)); border-radius: 5px; background: color-mix(in srgb, var(--colorError) 7%, var(--mainBackground)); color: var(--textColorPrimary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
        .power-helm .helm-inline-alert > .Icon { color: var(--colorError); flex-shrink: 0; margin-top: 1px; }
        .power-helm .helm-validation-pending { display: block; margin-top: 8px; color: var(--textColorSecondary); }
        .power-helm .helm-error { color: var(--colorError); overflow-wrap: anywhere; }
        .power-helm .helm-spinner { display: inline-flex; animation: power-helm-spin 1s linear infinite; }
        :root .power-helm .Button:not(.helm-tab):not(.helm-release-link):not(.helm-inline-action):not(.primary) { color: var(--textColorPrimary); background: var(--mainBackground); border: 1px solid var(--borderColor); border-radius: 4px; min-height: 30px; padding: 5px 10px; font-size: 12px; }
        :root .power-helm .Button:not(.helm-tab):not(.helm-release-link):not(.helm-inline-action):not(.primary):not(:disabled):hover { background: var(--contentColor); border-color: var(--textColorSecondary); }
        :root .power-helm .Button:disabled { opacity: .5; cursor: default; }
        .power-helm .helm-version-progress { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 30px; margin: 0 0 10px; color: var(--textColorSecondary); font-size: 12px; }
        .power-helm .helm-version-progress progress { width: 90px; height: 4px; accent-color: var(--primary); }
        .power-helm .helm-version-progress progress { appearance: none; border: 0; border-radius: 2px; overflow: hidden; }
        .power-helm .helm-version-progress progress::-webkit-progress-bar { background: var(--borderColor); }
        .power-helm .helm-version-progress progress::-webkit-progress-value { background: var(--primary); }
        .power-helm .helm-history-empty { text-align: center; padding: 24px 12px; color: var(--textColorSecondary); }
        .power-helm .helm-version-unavailable { color: var(--colorWarning, var(--textColorSecondary)); }
        .power-helm .helm-version-progress .Button { font-size: 12px; padding: 2px 6px; }
        .power-helm .helm-app-version-cell { display: inline-flex; align-items: center; min-width: 24px; }
        .power-helm .helm-app-version-placeholder { color: var(--textColorSecondary); opacity: .55; }
        .power-helm .helm-app-version-retry { display: inline-flex; padding: 0; background: transparent; border: 0; color: var(--textColorSecondary); cursor: pointer; }
        .power-helm .helm-app-version-retry:hover, .power-helm .helm-app-version-retry:focus-visible { color: var(--primary); }
        .power-helm .helm-table-frame { flex: 0 1 auto; min-height: 0; border: 1px solid var(--borderColor); border-radius: 6px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
        .power-helm > header, .power-helm > .helm-toolbar, .power-helm > .helm-list-summary, .power-helm > .helm-version-progress { flex-shrink: 0; }
        .power-helm .helm-table { --helm-row-highlight: var(--tableBgcSelected, color-mix(in srgb, var(--primary) 6%, var(--mainBackground))); width: 100%; border-collapse: collapse; font-size: 13px; }
        .power-helm .helm-table th { position: sticky; top: 0; z-index: 1; background: var(--contentColor); font-weight: 500; color: var(--textColorSecondary); white-space: nowrap; }
        .power-helm .helm-table th, .power-helm .helm-table td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--borderColor); }
        .power-helm .helm-table-frame .helm-table td:not(:first-child) { white-space: nowrap; }
        .power-helm .helm-table-frame .helm-table td:first-child { min-width: 240px; }
        .power-helm .helm-table-frame .helm-table :is(th, td):first-child { position: sticky; left: 0; z-index: 2; background: var(--mainBackground); box-shadow: 1px 0 var(--borderColor); }
        .power-helm .helm-table-frame .helm-table th:first-child { z-index: 3; background: var(--contentColor); }
        .power-helm .helm-table-frame .helm-table :is(tr:hover, tr[data-selected=true]) td:first-child { background: var(--helm-row-highlight); }
        .power-helm .helm-table-frame:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-helm .helm-table tbody tr:last-child td { border-bottom: 0; }
        .power-helm .helm-table tbody tr:hover, .power-helm .helm-table tr[data-selected=true] { background: var(--helm-row-highlight); }
        :root .power-helm .Button.helm-release-link { display: block; max-width: min(32vw, 460px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: transparent; border: 0; padding: 0; min-height: 0; color: var(--textColorAccent); font-size: 13px; text-align: left; box-shadow: none; }
        :root .power-helm .Button.helm-release-link:hover { color: var(--primary); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status { display: inline-flex; white-space: nowrap; font-size: 11px; line-height: 18px; padding: 1px 7px; border-radius: 4px; color: var(--textColorSecondary); background: var(--contentColor); border: 1px solid var(--borderColor); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=deployed] { color: var(--colorOk, var(--textColorAccent)); background: color-mix(in srgb, var(--colorOk, var(--primary)) 9%, var(--mainBackground)); border-color: color-mix(in srgb, var(--colorOk, var(--primary)) 25%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=failed] { color: var(--colorError); border-color: color-mix(in srgb, var(--colorError) 30%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status^=pending-], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalling] { color: var(--colorWarning, var(--textColorAccent)); background: color-mix(in srgb, var(--colorWarning, var(--primary)) 9%, var(--mainBackground)); border-color: color-mix(in srgb, var(--colorWarning, var(--primary)) 30%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=superseded], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalled], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=unknown] { color: var(--textColorSecondary); background: var(--contentColor); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalled] { border-style: dashed; }
        .power-helm .helm-panel { display: flex; flex-direction: column; position: absolute; inset: 0 0 0 auto; width: min(640px, 90%); box-sizing: border-box; background: var(--mainBackground); border-left: 1px solid var(--borderColor); box-shadow: -12px 0 30px color-mix(in srgb, var(--textColorPrimary) 8%, transparent); overflow: hidden; z-index: 5; }
        .power-helm .helm-panel:has(.helm-revision-diff) { width: min(1100px, calc(100% - 24px)); }
        .power-helm .helm-panel-actions { display: flex; align-items: center; gap: 4px; }
        .helm-release-actions-menu { max-height: min(360px, 70vh); overflow-y: auto; }
        .helm-release-actions-menu .MenuItem { gap: 8px; }
        .power-helm .helm-panel-heading { flex-shrink: 0; background: var(--mainBackground); display: flex; justify-content: space-between; align-items: start; padding: 22px 22px 18px; gap: 12px; }
        .power-helm .helm-panel-heading h2 { overflow-wrap: anywhere; }
        .power-helm .helm-panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
        .power-helm .helm-tabs { flex-shrink: 0; background: var(--mainBackground); display: flex; overflow-x: auto; padding: 0 18px; gap: 4px; border-bottom: 1px solid var(--borderColor); }
        :root .power-helm .Button.helm-tab { background: transparent; border: 0; border-radius: 0; padding: 12px 8px; color: var(--textColorSecondary); white-space: nowrap; box-shadow: none; border-bottom: 2px solid transparent; }
        :root .power-helm .Button.helm-tab-active { color: var(--textColorPrimary); border-bottom-color: var(--primary); }
        .power-helm .helm-panel-content { min-height: 0; overflow: auto; flex: 1; padding: 18px 22px 24px; }
        .power-helm .helm-overview-card { border: 1px solid var(--borderColor); border-radius: 6px; overflow: hidden; }
        .power-helm .helm-overview-card > header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 6px 12px 6px 16px; background: var(--contentColor); border-bottom: 1px solid var(--borderColor); }
        .power-helm .helm-overview-card h3 { margin: 0; font-size: 12px; font-weight: 500; }
        .power-helm .helm-overview { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; padding: 0 16px; }
        .power-helm .helm-overview > div { display: flex; flex-direction: column; gap: 7px; min-width: 0; padding: 15px 0; border-bottom: 1px solid var(--borderColor); }
        .power-helm .helm-overview > div:last-child { border: 0; }
        .power-helm .helm-overview dt { color: var(--textColorSecondary); font-size: 11px; }
        .power-helm .helm-overview .helm-overview-description { grid-column: 1 / -1; }
        .power-helm .helm-overview dd { font-size: 13px; line-height: 1.5; }
        .power-helm .helm-overview dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
        .power-helm .helm-edit-notice { display: flex; align-items: start; gap: 10px; padding: 12px; border: 1px solid var(--borderColor); border-radius: 4px; margin-bottom: 14px; }
        .power-helm .helm-edit-notice p { margin-top: 5px; color: var(--textColorSecondary); font-size: 12px; line-height: 1.5; }
        .power-helm .helm-values-editor > .helm-filter { margin: 12px 0; }
        .power-helm .helm-values-editor > .helm-toolbar { position: sticky; bottom: -24px; z-index: 4; margin: 12px -22px -24px; padding: 12px 22px; border-top: 1px solid var(--borderColor); background: var(--mainBackground); box-shadow: 0 -6px 12px color-mix(in srgb, var(--mainBackground) 70%, transparent); }
        .power-helm .helm-revision-notice, .power-helm .helm-viewing-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; color: var(--textColorSecondary); font-size: 12px; padding: 10px 12px; border: 1px solid var(--borderColor); border-radius: 4px; }
        .power-helm .helm-viewing-banner { margin: 0 22px 14px; }
        .power-helm .helm-comparison-baseline { min-width: 220px; }
        .power-helm .helm-current-baseline { display: block; margin-top: 4px; }
        .power-helm .helm-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
        .power-helm .helm-code-header + .helm-code-view { border: 1px solid var(--borderColor); border-top: 0; border-radius: 0 0 6px 6px; }
        .power-helm .helm-code-view { overscroll-behavior: contain; }
        .power-helm .helm-code-header { display: flex; justify-content: space-between; align-items: center; background: var(--contentColor); border: 1px solid var(--borderColor); border-radius: 6px 6px 0 0; padding: 8px 12px; color: var(--textColorSecondary); font-size: 12px; }
        .power-helm pre { margin: 0; padding: 16px; font-size: 12px; line-height: 1.65; border: 1px solid var(--borderColor); border-top: 0; border-radius: 0 0 6px 6px; max-height: 65vh; overflow: auto; }
        .power-helm .helm-panel-content:has(> .helm-history-layout) { display: flex; overflow: hidden; }
        .power-helm .helm-access-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid var(--borderColor); border-radius: 4px; color: var(--textColorSecondary); font-size: 11px; white-space: nowrap; }
        .power-helm .helm-history-layout { display: flex; flex-direction: column; min-height: 0; width: 100%; flex: 1; }
        .power-helm .helm-history-layout > :not(.helm-history-frame) { flex-shrink: 0; }
        .power-helm .helm-history-layout > .helm-request-status { justify-content: flex-end; margin-bottom: 12px; }
        .power-helm .helm-history-frame { flex: 0 1 auto; min-height: 80px; overflow: auto; border: 1px solid var(--borderColor); border-radius: 6px; overscroll-behavior: contain; scrollbar-gutter: stable; }
        .power-helm .helm-history-frame:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-helm .helm-history-table { font-size: 12px; }
        .power-helm .helm-history-table th, .power-helm .helm-history-table td { padding: 8px 10px; white-space: nowrap; }
        .power-helm .helm-history-table .helm-inline-action { white-space: nowrap; font-size: 12px; }
        .power-helm .helm-history-table input[type=radio] { appearance: none; width: 14px; height: 14px; border: 1px solid var(--textColorSecondary); border-radius: 50%; background: var(--mainBackground); cursor: pointer; }
        .power-helm .helm-history-table input[type=radio]:checked { background: var(--primary); border-color: var(--primary); box-shadow: inset 0 0 0 3px var(--mainBackground); }
        .power-helm .helm-history-table input[type=radio]:disabled { opacity: .45; cursor: default; }
        .power-helm .helm-consent { position: relative; }
        .power-helm .helm-consent input[type=checkbox] { display: block; position: absolute; left: 0; top: 50%; width: 14px; height: 14px; transform: translateY(-50%); opacity: 0; margin: 0; z-index: 1; }
        .power-helm .helm-consent input:focus-visible ~ .box { outline: 2px solid var(--primary); outline-offset: 3px; }
        .power-helm .helm-consent-target { display: inline; line-height: 1.8; overflow-wrap: anywhere; }
        .power-helm .helm-consent-target strong { font-weight: 500; }
        .power-helm .helm-consent-revision { display: inline-block; margin: 0 4px; padding: 0 6px; color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); border: 1px solid color-mix(in srgb, var(--primary) 25%, var(--borderColor)); border-radius: 4px; font-weight: 600; white-space: nowrap; }
        .power-helm .helm-consent-version { display: inline-block; color: var(--textColorSecondary); font-size: 11px; white-space: nowrap; }
        .power-helm .helm-current-tag { margin-left: 7px; color: var(--textColorSecondary); font-size: 10px; }
        :root .power-helm .Button.helm-inline-action { border-color: transparent; background: transparent; color: var(--primary); padding: 4px 6px; }
        .power-helm .helm-history-table label { cursor: pointer; display: inline-flex; align-items: center; }
        .power-helm .helm-rollback { margin-top: 16px; padding: 12px; min-height: 110px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--colorWarning, var(--primary)) 35%, var(--borderColor)); border-radius: 6px; }
        .power-helm .helm-rollback-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; margin-top: 12px; }
        .power-helm .helm-rollback-controls > .Button { min-height: 30px; white-space: nowrap; }
        .power-helm .helm-rollback-controls .helm-consent { margin: 0; min-height: 32px; }
        .power-helm .helm-rollback-title { display: flex; align-items: center; gap: 8px; font-weight: 500; }
        .power-helm .helm-rollback p { color: var(--textColorSecondary); margin-top: 8px; font-size: 12px; line-height: 1.5; }
        .power-helm .helm-consent { display: flex; margin: 16px 0; font-size: 12px; }
        .power-helm .helm-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 42px 20px; color: var(--textColorSecondary); }
        .ConfirmDialog:has(.power-helm-confirmation) > .box { min-width: min(360px,calc(100vw - 32px)); max-width: min(640px,calc(100vw - 32px)); }
        .ConfirmDialog:has(.power-helm-confirmation) .confirm-content { gap: 12px; }
        .ConfirmDialog:has(.power-helm-confirmation .helm-revision-diff) > .box { width: min(1100px, calc(100vw - 64px)); max-width: min(1100px, calc(100vw - 64px)); }
        .ConfirmDialog:has(.power-helm-confirmation .helm-revision-diff) .confirm-content { align-items: flex-start; }
        .ConfirmDialog:has(.power-helm-confirmation .helm-revision-diff) .confirm-content > .Icon { align-self: flex-start; margin-top: 4px; }
        .ConfirmDialog .helm-rollback-confirmation p { margin: 8px 0 12px; }
        .ConfirmDialog .helm-confirmation-target { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 12px; border: 1px solid var(--borderColor); border-radius: 6px; background: var(--mainBackground); }
        .ConfirmDialog .helm-revision-badge { display: inline-flex; min-width: 28px; justify-content: center; padding: 2px 7px; border-radius: 4px; background: var(--primary); color: var(--textColorAccent); font-weight: 600; }
        .ConfirmDialog .helm-target-version, .ConfirmDialog .helm-confirmation-explanation { color: var(--textColorSecondary); font-size: 12px; }
        .ConfirmDialog .helm-confirmation-heading { position: sticky; top: 0; z-index: 3; background: var(--contentColor); padding-bottom: 12px; }
        .ConfirmDialog:has(.power-helm-confirmation .helm-revision-diff) .power-helm-confirmation { overscroll-behavior: contain; scrollbar-gutter: stable; flex: 1; min-width: 0; max-height: 66vh; overflow: auto; padding-right: 4px; }

        .ConfirmDialog:has(.power-helm-confirmation) .confirm-content > .Icon { flex-shrink: 0; margin: 0; }
        .ConfirmDialog:has(.power-helm-confirmation) .power-helm-confirmation { display: block; line-height: 1.6; overflow-wrap: anywhere; color: var(--textColorPrimary); }
        .ConfirmDialog:has(.power-helm-confirmation) .power-helm-confirm { background: var(--colorError, #c64b4b); color: white; }
        @keyframes power-helm-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .power-helm .helm-spinner { animation: none; } }
      `}</style>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div className="helm-page-title">
          <Icon svg="helm" />
          <div>
            <h2>Helm</h2>
            <span>Releases</span>
          </div>
        </div>
        <NativeTooltip title="Native Helm">
          <button
            type="button"
            className="helm-native-button"
            aria-label="Open native Helm"
            onClick={() => Renderer.Navigation.navigate("/helm/releases?power-native=1")}
          >
            <Icon material="open_in_new" size={16} />
          </button>
        </NativeTooltip>
      </header>
      {!enabled ? (
        <p>Helm enhancements are disabled</p>
      ) : clusterId ? (
        <ClusterHelm key={partition} clusterId={clusterId} partition={partition} />
      ) : (
        <p>Select a cluster to view Helm releases</p>
      )}
    </div>
  );
});
