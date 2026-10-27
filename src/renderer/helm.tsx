import { Renderer } from "@freelensapp/extensions";
import { clipboard, ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "../common/date-time";
import {
  HELM_CHANNEL,
  HELM_INSTALLED_CHART,
  type HelmOperation,
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
import { HelmCodeView, HelmRevisionDiff, openHelmDocumentFind } from "./helm-code-view";
import { HelmOperationsPanel, helmOperations } from "./helm-operations";
import { HelmReleaseActions } from "./helm-release-actions";
import { HelmRevisionDelete } from "./helm-revision-delete";
import { useHelmVersionIndex } from "./helm-version-index";
import { NativeTooltip } from "./native-tooltip";

function HelmSearchField({
  value,
  onChange,
  label,
  placeholder,
  clearLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  clearLabel: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="helm-search-field">
      <input
        ref={input}
        className="helm-text-input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          className="helm-search-clear"
          aria-label={clearLabel}
          onClick={(event) => {
            event.preventDefault();
            onChange("");
            input.current?.focus();
          }}
        >
          <Icon material="close" size={16} />
        </button>
      )}
    </div>
  );
}

const ReadOnlyDocumentIndicator = observer(() => {
  if (!ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled) return null;
  return (
    <span className="helm-access-badge" role="status" aria-label="Read only">
      <Icon material="lock_outline" size={14} />
      Read only
    </span>
  );
});

function ReleaseTimestamp({ value }: { value?: string | number }) {
  if (value === undefined || value === "") return <>—</>;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <>Unavailable</>;
  const timestamp = date.toISOString();
  return (
    <NativeTooltip title={`UTC: ${timestamp}`}>
      <time className="helm-timestamp" dateTime={timestamp}>
        {formatDateTime(value)}
      </time>
    </NativeTooltip>
  );
}

function ReleaseAppVersion({
  clusterId,
  contextId,
  release,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
}) {
  if (!contextId) return null;
  return (
    <span className="helm-release-app-version">
      App version <HelmAppVersionCell clusterId={clusterId} contextId={contextId} release={release} />
    </span>
  );
}

function ReleaseOverview({ overview, actions }: { overview: HelmOverview; actions: ReactNode }) {
  const fields = [
    ["Revision", overview.revision],
    ["Name", overview.name],
    ["App version", overview.appVersion],
    ["Namespace", overview.namespace],
    ["Chart version", overview.chartVersion],
    ["Status", overview.status],
    ["Chart", overview.chartName || overview.chart],
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
            <div
              key={label}
              data-field={label}
              className={label === "Description" ? "helm-overview-description" : undefined}
            >
              <dt>{label}</dt>
              <dd>
                {label === "Status" ? (
                  <StatusBadge status={String(value)} />
                ) : label === "Updated" ? (
                  <ReleaseTimestamp value={String(value)} />
                ) : label === "Revision" || label === "App version" || label === "Chart version" ? (
                  <span className="helm-version-badge helm-overview-version-badge">{String(value)}</span>
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
      {index.completed < index.total && (
        <NativeTooltip
          title={
            paused
              ? "Continue checking app versions from the saved progress"
              : "Pause background checks and keep the versions already found"
          }
        >
          <Button onClick={onToggle}>
            <Icon material={paused ? "play_arrow" : "pause"} size={16} />
            <span>{paused ? "Resume" : "Pause"}</span>
          </Button>
        </NativeTooltip>
      )}
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
const { Button, Checkbox, Drawer, Icon, Select } = Renderer.Component;

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
    const payload: HelmRequest = {
      ...request,
      requestId: `${session}-${++requestSequence}`,
      refresh: request.refresh || attempt > 0,
    };
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
  labeled = false,
  showTimestamp = true,
  loadingLabel = "Loading…",
  compact = false,
}: {
  state: ReturnType<typeof useHelmRequest>;
  refreshLabel?: string;
  labeled?: boolean;
  showTimestamp?: boolean;
  loadingLabel?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={`helm-request-status${compact ? " helm-request-compact" : ""}`}
      data-error={Boolean(state.error)}
      aria-busy={state.loading}
    >
      {state.loading && compact && (
        <NativeTooltip title="Cancel loading">
          <button
            type="button"
            className="helm-icon-button helm-loading-cancel"
            aria-label="Cancel loading"
            onClick={state.cancel}
          >
            <span aria-hidden="true" className="helm-spinner">
              <Icon material="autorenew" size={18} />
            </span>
            <span aria-hidden="true" className="helm-cancel-icon">
              <Icon material="close" size={18} />
            </span>
            <span className="helm-sr-only">{loadingLabel}</span>
          </button>
        </NativeTooltip>
      )}
      {state.loading && !compact && (
        <>
          <span className="helm-loading" aria-label={compact ? loadingLabel : undefined}>
            <span aria-hidden="true" className="helm-spinner">
              <Icon material="autorenew" />
            </span>
            {compact ? <span className="helm-sr-only">{loadingLabel}</span> : loadingLabel}
          </span>
          <NativeTooltip title="Cancel loading">
            <button type="button" className="helm-icon-button" aria-label="Cancel loading" onClick={state.cancel}>
              <Icon material="close" size={18} />
            </button>
          </NativeTooltip>
        </>
      )}
      {state.error && (
        <>
          <span role="alert" className="helm-error">
            <Icon material="error_outline" size={16} />
            {state.error}
          </span>
          <Button
            className="helm-comparison-toggle"
            aria-label="Retry"
            label={
              <>
                <Icon material="refresh" size={16} />
                <span>Retry</span>
              </>
            }
            onClick={state.refresh}
          />
        </>
      )}
      {!state.loading && !state.error && (
        <NativeTooltip title={refreshLabel}>
          {labeled ? (
            <Button
              className="helm-comparison-toggle"
              aria-label={refreshLabel}
              label={
                <>
                  <Icon material="refresh" size={18} />
                  {refreshLabel}
                </>
              }
              onClick={state.refresh}
            />
          ) : (
            <button type="button" className="helm-icon-button" aria-label={refreshLabel} onClick={state.refresh}>
              <Icon material="refresh" size={18} />
              <span className="helm-sr-only">{refreshLabel}</span>
            </button>
          )}
        </NativeTooltip>
      )}
      {showTimestamp && state.result?.ok && state.result.fetchedAt && (
        <small>
          {state.stale || state.loading || state.error || state.result.cached ? "Cached · " : "Updated · "}
          <ReleaseTimestamp value={state.result.fetchedAt} />
        </small>
      )}
    </div>
  );
}

function HelmPagination({
  page,
  pages,
  kind,
  onChange,
}: {
  page: number;
  pages: number;
  kind: "releases" | "revisions";
  onChange: (page: number) => void;
}) {
  return (
    <nav className="helm-toolbar helm-pagination" aria-label={`Helm ${kind} pages`}>
      <NativeTooltip title={`Previous ${kind}`}>
        <button type="button" aria-label={`Previous ${kind}`} disabled={page === 0} onClick={() => onChange(page - 1)}>
          <Icon material="chevron_left" size={16} />
        </button>
      </NativeTooltip>
      <span>
        Page {page + 1} / {pages}
      </span>
      <NativeTooltip title={`Next ${kind}`}>
        <button
          type="button"
          aria-label={`Next ${kind}`}
          disabled={page + 1 >= pages}
          onClick={() => onChange(page + 1)}
        >
          <Icon material="chevron_right" size={16} />
        </button>
      </NativeTooltip>
    </nav>
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
  initialCompare = false,
  isOverlayEscape,
  restoreControls,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  tab: HelmSection;
  currentRelease: HelmReleaseMetadata;
  deployedRelease?: HelmReleaseMetadata;
  initialCompare?: boolean;
  isOverlayEscape?: (event: KeyboardEvent) => boolean;
  restoreControls?: ReactNode;
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
  const [compare, setCompare] = useState(initialCompare);
  const [baseline, setBaseline] = useState("latest");
  const [comparisonToolbar, setComparisonToolbar] = useState<HTMLDivElement | null>(null);
  const [comparisonReady, setComparisonReady] = useState(false);
  const comparisonRelease = baseline === "deployed" && deployedRelease ? deployedRelease : currentRelease;
  const [editing, setEditing] = useState(false);
  const [codeActions, setCodeActions] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isOverlayEscape?.(event) ||
        document.querySelector(
          '[data-testid="confirmation-dialog"], .Select__menu, .helm-release-actions-menu, .monaco-editor .find-widget.visible, .helm-diff-find, .power-helm-operation-dialog',
        )
      )
        return;
      if (editing || (compare && !initialCompare)) {
        event.preventDefault();
        event.stopPropagation();
        if (!editing) setCompare(false);
      }
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [editing, compare, initialCompare, isOverlayEscape]);
  const historical = release.revision !== currentRelease.revision;
  const detail = state.result?.ok ? state.result.detail : undefined;
  const [copySequence, setCopySequence] = useState(0);
  const copied = copySequence > 0;
  useEffect(() => {
    setCopySequence(0);
  }, [detail?.content]);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopySequence(0), 2000);
    return () => clearTimeout(timeout);
  }, [copySequence]);
  const lineCount = useMemo(() => {
    const content = detail?.content ?? "";
    let count = content ? 1 : 0;
    for (let index = 0; index < content.length; index++) if (content.charCodeAt(index) === 10) count++;
    return count;
  }, [detail?.content]);
  const inlineRefresh = Boolean(detail && tab !== "notes" && !(tab === "overview" && detail.overview));
  const comparisonToggle = (
    <Button
      className="helm-comparison-toggle"
      aria-label={compare ? "Show revision" : "Compare with current"}
      label={
        <>
          <Icon material={compare ? "visibility" : "difference"} size={18} />
          {compare ? "Show revision" : "Compare with current"}
        </>
      }
      disabled={state.loading || Boolean(state.error) || state.stale}
      onClick={() => setCompare(!compare)}
    />
  );
  return (
    <div
      className={
        tab === "values" || tab === "manifest"
          ? `helm-document-section${compare ? " helm-comparison-active" : ""}`
          : tab === "notes"
            ? "helm-notes-section"
            : undefined
      }
    >
      {!(tab === "overview" && detail?.overview) &&
        !(tab === "notes" && detail && !detail.content.trim()) &&
        !inlineRefresh &&
        !(compare && (tab === "values" || tab === "manifest")) && (
          <RequestStatus
            state={state}
            labeled={tab === "notes"}
            refreshLabel={tab === "notes" ? "Refresh notes" : "Refresh"}
          />
        )}
      {compare && (tab === "values" || tab === "manifest") && detail && (
        <div className="helm-toolbar helm-comparison-toolbar">
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
          {comparisonToggle}
          {compare && <div className="helm-comparison-refresh" ref={setComparisonToolbar} />}
        </div>
      )}
      {tab === "values" && !historical && !compare && detail && (
        <ValuesEditing
          release={release}
          clusterId={clusterId}
          contextId={contextId}
          content={detail.content}
          editing={editing}
          disabled={state.loading || Boolean(state.error) || state.stale}
          actionTarget={codeActions}
          setEditing={setEditing}
          onChanged={() => {
            state.refresh();
            onChanged();
          }}
        />
      )}
      {!editing && compare && restoreControls && (
        <div className="helm-comparison-restore" hidden={!comparisonReady}>
          {restoreControls}
        </div>
      )}
      {!editing &&
        (compare && (tab === "values" || tab === "manifest") ? (
          <RevisionComparison
            key={`${tab}/${release.revision}/${comparisonRelease.revision}/${comparisonRelease.uid ?? ""}`}
            clusterId={clusterId}
            contextId={contextId}
            release={comparisonRelease}
            selected={release}
            baselineLabel={baseline === "deployed" && deployedRelease ? "Last deployed" : "Latest"}
            section={tab}
            selectedState={state}
            onReadyChange={setComparisonReady}
            toolbar={comparisonToolbar}
          />
        ) : (
          <>
            {detail && tab === "overview" && detail.overview && (
              <ReleaseOverview
                overview={detail.overview}
                actions={<RequestStatus state={state} refreshLabel="Refresh overview" />}
              />
            )}
            {detail && tab === "notes" && !detail.content.trim() && (
              <div className="helm-notes-state">
                <RequestStatus state={state} refreshLabel="Refresh notes" showTimestamp={false} labeled />
                <div className="helm-notes-empty" role="status">
                  <Icon material="description" size={24} />
                  <strong>No release notes</strong>
                  <span>This chart did not provide notes for this revision.</span>
                </div>
              </div>
            )}
            {detail &&
              (tab !== "overview" || !detail.overview) &&
              (tab !== "notes" || Boolean(detail.content.trim())) && (
                <>
                  <div className="helm-code-header">
                    <span>
                      {tab === "notes" ? "Release notes" : `${tab.charAt(0).toUpperCase() + tab.slice(1)} · YAML`}
                      {!historical && <ReadOnlyDocumentIndicator />}
                    </span>
                    <small>
                      {lineCount} {lineCount === 1 ? "line" : "lines"}
                    </small>
                    <span className="helm-copy-action">
                      {historical && (tab === "values" || tab === "manifest") && comparisonToggle}
                      {tab === "values" && <span ref={setCodeActions} className="helm-edit-action" />}
                      <span role="status" className="helm-sr-only">
                        {copied ? "Copied" : ""}
                      </span>
                      <NativeTooltip title={copied ? "Copied" : "Copy"}>
                        <Button
                          aria-label="Copy"
                          label={
                            <>
                              <Icon material={copied ? "check" : "content_copy"} size={16} />
                              Copy
                            </>
                          }
                          onClick={() => {
                            clipboard.writeText(detail.content);
                            setCopySequence((value) => value + 1);
                          }}
                        />
                      </NativeTooltip>
                      {inlineRefresh && (
                        <RequestStatus state={state} refreshLabel={`Refresh ${tab}`} showTimestamp={false} compact />
                      )}
                    </span>
                  </div>
                  {tab === "notes" ? (
                    <pre
                      className="helm-notes"
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
                    <HelmCodeView
                      value={detail.content}
                      ariaLabel={`${tab} for revision ${release.revision}`}
                      style={{ height: "100%", minHeight: 0, flex: 1 }}
                    />
                  )}
                </>
              )}
          </>
        ))}
    </div>
  );
}

const ValuesEditing = observer(
  ({
    release,
    clusterId,
    contextId,
    content,
    editing,
    disabled,
    actionTarget,
    setEditing,
    onChanged,
  }: {
    release: HelmReleaseMetadata;
    clusterId: string;
    contextId?: string;
    content: string;
    editing: boolean;
    disabled?: boolean;
    actionTarget: HTMLElement | null;
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
    ) : actionTarget ? (
      createPortal(
        <Button
          aria-label="Edit values"
          disabled={disabled || helmOperations.isRunning(clusterId, contextId, release.namespace, release.name)}
          label={
            <>
              <Icon material="edit" size={16} />
              Edit values
            </>
          }
          onClick={() => setEditing(true)}
        />,
        actionTarget,
      )
    ) : null;
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
    const sourceStatusRef = useRef<HTMLDivElement>(null);
    const [sourceStatusHeight, setSourceStatusHeight] = useState(0);
    useLayoutEffect(() => {
      const root = sourceStatusRef.current;
      if (state.loading || choices.length || !root) return;
      const measure = () => setSourceStatusHeight(root.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(root);
      return () => observer.disconnect();
    }, [state.loading, state.error, choices.length]);
    const selectedChart = chart || choices[0]?.ref || "";
    const permitted = Boolean(
      state.result?.ok &&
        state.result.upgradeAllowed &&
        !state.loading &&
        !state.stale &&
        !state.error &&
        !ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled &&
        PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled &&
        !helmOperations.isRunning(clusterId, contextId, release.namespace, release.name),
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
        {!choices.length && (
          <div
            ref={sourceStatusRef}
            className={`helm-chart-source-status${state.loading ? " helm-chart-source-loading" : ""}`}
            style={state.loading && sourceStatusHeight ? { minHeight: sourceStatusHeight } : undefined}
          >
            <RequestStatus state={state} refreshLabel="Refresh chart sources" loadingLabel="Loading chart sources…" />
            {!state.loading && !state.error && (
              <p role="alert">
                No matching chart is available in your Helm repositories. Add the repository for this chart before
                editing values.
              </p>
            )}
          </div>
        )}
        {choices.length > 0 && (
          <label className="helm-filter">
            <span className="helm-field-heading">
              Chart source · same version
              <RequestStatus state={state} refreshLabel="Refresh chart sources" />
            </span>
            <Select
              aria-label="Chart source"
              value={selectedChart}
              options={choices.map((choice) => ({
                value: choice.ref,
                label: `${choice.ref === HELM_INSTALLED_CHART ? "Installed release chart" : choice.ref} · ${choice.version}`,
              }))}
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
          style={{ height: "100%", minHeight: 0, flex: 1 }}
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
            className="helm-comparison-toggle"
            aria-label={refreshing ? "Refreshing…" : busy ? "Applying…" : "Review changes"}
            label={
              <>
                <Icon material={refreshing || busy ? "autorenew" : "difference"} size={16} />
                {refreshing ? "Refreshing…" : busy ? "Applying…" : "Review changes"}
              </>
            }
            disabled={!ready}
            onClick={save}
          />
          <Button
            className="helm-comparison-toggle"
            aria-label="Cancel editing"
            label={
              <>
                <Icon material="close" size={16} />
                Cancel editing
              </>
            }
            disabled={busy}
            onClick={onCancel}
          />
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
  selectedState,
  onReadyChange,
  baselineLabel,
  toolbar,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  selected: HelmReleaseMetadata;
  section: HelmSection;
  selectedState: ReturnType<typeof useHelmRequest>;
  onReadyChange: (ready: boolean) => void;
  baselineLabel: string;
  toolbar: HTMLElement | null;
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
  const selectedDetail = selectedState.result?.ok ? selectedState.result.detail : undefined;
  const combinedState = {
    ...state,
    loading: selectedState.loading || state.loading,
    stale: selectedState.stale || state.stale,
    error: selectedState.error || state.error,
    cancel: () => {
      selectedState.cancel();
      state.cancel();
    },
    refresh: () => {
      selectedState.refresh();
      state.refresh();
    },
  };
  const ready = !combinedState.loading && !combinedState.error && !combinedState.stale && current && selectedDetail;
  useLayoutEffect(() => onReadyChange(Boolean(ready)), [Boolean(ready), onReadyChange]);
  return (
    <>
      {!ready && (
        <div className="helm-comparison-loading" aria-label="Comparison loading state">
          <RequestStatus state={combinedState} loadingLabel="Loading comparison…" showTimestamp={false} labeled />
          {!combinedState.loading && !combinedState.error && (
            <span>Refresh to load both revisions for comparison.</span>
          )}
        </div>
      )}
      {ready && toolbar && createPortal(<RequestStatus state={combinedState} labeled />, toolbar)}
      {ready && (
        <HelmRevisionDiff
          before={selectedDetail.content}
          after={current.content}
          beforeLabel={
            <>
              <span className="helm-version-badge">Revision {selected.revision}</span>
              <StatusBadge status={selected.status} />
              <ReleaseAppVersion clusterId={clusterId} contextId={contextId} release={selected} />
            </>
          }
          afterLabel={
            <>
              <span className="helm-version-badge">
                {baselineLabel} · Revision {release.revision}
              </span>
              <StatusBadge status={release.status} />
              <ReleaseAppVersion clusterId={clusterId} contextId={contextId} release={release} />
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
    onView,
    onLatest,
    onDeployed,
    generation,
    restoreTarget,
  }: {
    clusterId: string;
    contextId?: string;
    release: HelmReleaseMetadata;
    onView: (revision: HelmReleaseMetadata, compare?: boolean) => void;
    onLatest: (revision: HelmReleaseMetadata) => void;
    onDeployed: (revision: HelmReleaseMetadata | undefined) => void;
    generation: number;
    restoreTarget?: HelmReleaseMetadata;
  }) => {
    const state = useHelmRequest(
      {
        clusterId,
        contextId,
        namespace: release.namespace,
        operation: "history",
        refresh: Boolean(restoreTarget),
        name: release.name,
      },
      undefined,
      generation,
    );
    const [selectedRevision, setRevision] = useState<number>();
    const revision = restoreTarget?.revision ?? selectedRevision;
    const [versionGeneration, setVersionGeneration] = useState(0);
    const [revisionFilter, setRevisionFilter] = useState("");
    const [page, setPage] = useState(0);
    const historyFrame = useRef<HTMLDivElement>(null);
    const [revealRevision, setRevealRevision] = useState<{ revision: number; result: HelmResponse }>();
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
      if (revealRevision === undefined) return;
      if (revealRevision.result !== state.result) {
        setRevealRevision(undefined);
        return;
      }
      if (revisionFilter) {
        setRevisionFilter("");
        setPage(0);
        return;
      }
      const entries = state.result?.ok ? (state.result.releases ?? []) : [];
      const index = entries.findIndex((item) => item.revision === revealRevision.revision);
      if (index < 0) {
        setRevealRevision(undefined);
        return;
      }
      const targetPage = Math.floor(index / 50);
      if (page !== targetPage) {
        setPage(targetPage);
        return;
      }
      const row = historyFrame.current?.querySelector<HTMLTableRowElement>(
        `tr[data-revision="${revealRevision.revision}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ block: "nearest" });
      row.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      setRevealRevision(undefined);
    }, [revealRevision, revisionFilter, page, state.result]);
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
    useEffect(
      () => setConfirmed(false),
      [state.result, state.loading, generation, contextId, restoreTarget?.revision, restoreTarget?.uid],
    );
    const [requestBusy, setBusy] = useState(false);
    const busy = requestBusy || helmOperations.isRunning(clusterId, contextId, release.namespace, release.name);
    const [error, setError] = useState("");
    const live = useRef(true);
    const operation = useRef<HelmRequest>();
    useEffect(
      () => () => {
        live.current = false;
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
    const historyCurrent =
      !state.loading &&
      !state.error &&
      !state.stale &&
      !(contextId && state.result?.ok && state.result.contextId && contextId !== state.result.contextId);
    const eligible = useRef(false);
    const target = state.result?.ok
      ? state.result.releases?.find(
          (item) =>
            item.revision === revision &&
            item.name === release.name &&
            item.namespace === release.namespace &&
            (!restoreTarget || (item.uid === restoreTarget.uid && item.revision !== release.revision)),
        )
      : undefined;
    eligible.current = Boolean(allowed && historyCurrent && target);
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
              <span className="helm-version-badge helm-revision-badge" aria-label={`Target revision ${revision}`}>
                Revision {revision}
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
        icon: <Icon material="warning" size={28} />,
        labelOk: (
          <>
            <Icon material="restore" size={18} />
            <span>Roll back to revision {revision}</span>
          </>
        ),
        okButtonProps: { className: "power-helm-confirm power-helm-confirm-rollback" },
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
          void helmOperations
            .start(payload)
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
              }
            });
        },
      });
    };
    const requestStatus = (
      <RequestStatus
        state={{
          ...state,
          refresh: () => {
            setVersionGeneration((value) => value + 1);
            state.refresh();
          },
        }}
        refreshLabel={restoreTarget ? "Refresh restore availability" : "Refresh"}
        showTimestamp={!restoreTarget}
      />
    );
    if (restoreTarget && readOnly) return null;
    return (
      <div className={restoreTarget ? "helm-restore-revision" : "helm-history-layout"}>
        {(!state.result?.ok || (restoreTarget && !allowed)) && requestStatus}
        {!restoreTarget && state.result?.ok && (
          <div className="helm-toolbar helm-history-tools">
            <HelmSearchField
              label="Search revision history"
              placeholder="Revision or App version"
              value={revisionFilter}
              onChange={setRevisionFilter}
              clearLabel="Clear revision search"
            />
            <small>
              {history.length !== (state.result.releases?.length ?? 0)
                ? `${history.length} of ${state.result.releases?.length ?? 0} revisions`
                : `${history.length} ${history.length === 1 ? "revision" : "revisions"}`}
            </small>
            {revision && (
              <NativeTooltip title="Return to the selected revision in the table">
                <Button
                  className="helm-inline-action"
                  aria-label="Show selected revision"
                  label={`Selected Revision ${revision}`}
                  onClick={() => {
                    if (!state.result?.ok) return;
                    setRevisionFilter("");
                    setPage(0);
                    setRevealRevision({ revision, result: state.result });
                  }}
                  disabled={busy || !historyCurrent}
                />
              </NativeTooltip>
            )}
            {readOnly && (
              <NativeTooltip title="Read-only mode is enabled. Revision contents and comparisons remain available">
                <span className="helm-access-badge" role="status" aria-label="Read only">
                  <Icon material="lock_outline" size={14} />
                  Read only
                </span>
              </NativeTooltip>
            )}
            <div className="helm-history-refresh">{requestStatus}</div>
          </div>
        )}
        {!restoreTarget && revisionFilter && (
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
        {!restoreTarget && state.result?.ok && (
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
                  <tr
                    key={item.revision}
                    data-revision={item.revision}
                    data-selected={revision === item.revision}
                    tabIndex={historyCurrent && !busy ? 0 : -1}
                    aria-disabled={!historyCurrent || busy}
                    onClick={(event) => {
                      if (
                        !historyCurrent ||
                        busy ||
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        window.getSelection()?.toString() ||
                        (event.target instanceof Element &&
                          event.target.closest("button, input, a, label, select, textarea, [role=button]"))
                      )
                        return;
                      onView(item);
                    }}
                    onKeyDown={(event) => {
                      if (
                        !historyCurrent ||
                        busy ||
                        event.defaultPrevented ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        event.target !== event.currentTarget ||
                        !["Enter", " "].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      onView(item);
                    }}
                  >
                    <td className="helm-revision-cell">
                      <div className="helm-history-revision">
                        {allowed ? (
                          <>
                            <label className="helm-revision-select">
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
                              />
                            </label>
                            <span className="helm-version-badge">{item.revision}</span>
                          </>
                        ) : (
                          <span className="helm-version-badge" aria-label={`Revision ${item.revision}`}>
                            {item.revision}
                          </span>
                        )}
                        {item.revision === release.revision && <span className="helm-current-tag">Current</span>}
                      </div>
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
                    <td>
                      <ReleaseTimestamp value={item.updatedAt} />
                    </td>
                    <td>
                      <div className="helm-history-actions">
                        <NativeTooltip title={`View values from revision ${item.revision}`}>
                          <button
                            type="button"
                            className="helm-icon-button helm-history-view"
                            aria-label="View revision"
                            disabled={!historyCurrent || busy}
                            onClick={() => onView(item)}
                          >
                            <Icon material="visibility" size={18} />
                          </button>
                        </NativeTooltip>
                        <NativeTooltip title={`Compare revision ${item.revision} with latest`}>
                          <button
                            type="button"
                            className="helm-icon-button helm-history-view"
                            aria-label={`Compare revision ${item.revision}`}
                            disabled={!historyCurrent || busy}
                            onClick={() => onView(item, true)}
                          >
                            <Icon material="difference" size={18} />
                          </button>
                        </NativeTooltip>
                        <HelmRevisionDelete
                          clusterId={clusterId}
                          contextId={contextId}
                          revision={item}
                          current={item.revision === release.revision}
                          allowed={Boolean(allowed && historyCurrent)}
                          busy={busy}
                          onDeleted={() => {
                            setRevision(undefined);
                            setConfirmed(false);
                            setError("");
                            state.refresh();
                          }}
                          onError={setError}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!restoreTarget && history.length > 50 && (
          <HelmPagination page={page} pages={Math.ceil(history.length / 50)} kind="revisions" onChange={setPage} />
        )}
        {allowed && (
          <>
            <div className="helm-rollback">
              <div className="helm-rollback-title">
                <Icon material="restore" size={18} />
                <span>Roll back release</span>
                {!revision && <span className="helm-rollback-hint">Select a revision to restore this release.</span>}
                {restoreTarget && requestStatus}
              </div>
              {restoreTarget && !target && historyCurrent && (
                <p role="alert">
                  {restoreTarget.revision === release.revision
                    ? "This revision is already current."
                    : "This revision is no longer available to restore. Refresh history before continuing."}
                </p>
              )}
              <div className="helm-rollback-controls">
                <Checkbox
                  className="helm-consent"
                  label={
                    <span className="helm-consent-target">
                      I confirm rolling back <strong>{release.name}</strong>
                      {target && (
                        <>
                          {" "}
                          to{" "}
                          <span className="helm-version-badge helm-consent-revision">Revision {target.revision}</span>
                          <span className="helm-consent-version">
                            App version{" "}
                            {versionIndex.versionFor(target)?.appVersion ? (
                              <span className="helm-version-badge helm-consent-revision">
                                {versionIndex.versionFor(target)?.appVersion}
                              </span>
                            ) : (
                              "—"
                            )}
                          </span>
                        </>
                      )}
                    </span>
                  }
                  value={confirmed}
                  disabled={busy || !revision || !historyCurrent || !target}
                  onChange={(value) => setConfirmed(value)}
                />
                <Button
                  className="helm-rollback-button"
                  aria-label={busy ? "Rolling back…" : "Roll back"}
                  label={
                    <>
                      <Icon material="restore" size={18} />
                      {busy ? "Rolling back…" : "Roll back"}
                    </>
                  }
                  disabled={!revision || !confirmed || busy || !historyCurrent || !target}
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

let nextTabIdentity = 0;

function ReleasePanel({
  clusterId,
  contextId,
  release,
  close,
  onChanged,
  onLatest,
  historyGeneration,
  uninstallAllowed,
  historyRequest = 0,
}: {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  close: () => void;
  onChanged: () => void;
  onLatest: (revision: HelmReleaseMetadata) => void;
  historyGeneration: number;
  uninstallAllowed: boolean;
  historyRequest?: number;
}) {
  const [tabIdentity] = useState(() => `helm-release-tabs-${++nextTabIdentity}`);
  const [deleteError, setDeleteError] = useState("");
  const overlayEscapes = useRef(new WeakSet<KeyboardEvent>());
  const overlayClicks = useRef(new WeakSet<Event>());
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const panel = useRef<HTMLElement>(null);
  const currentEvent = useRef<Event>();
  const latestClose = useRef(close);
  const previousScreen = useRef<() => void>();
  latestClose.current = close;
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const captureEvent = (event: Event) => {
      currentEvent.current = event;
      if (
        event.type === "click" &&
        event.target instanceof Element &&
        event.target.closest(
          '.helm-panel, .Select__menu, .helm-release-actions-menu, .power-helm-operation-dialog, [data-testid="confirmation-dialog"]',
        )
      ) {
        overlayClicks.current.add(event);
      }
      window.setTimeout(() => {
        if (currentEvent.current === event) currentEvent.current = undefined;
      }, 0);
    };
    window.addEventListener("click", captureEvent, true);
    window.addEventListener("keydown", captureEvent, true);
    const captureEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        document.querySelector(
          '[data-testid="confirmation-dialog"], .Select__menu, .helm-release-actions-menu, .monaco-editor .find-widget.visible, .helm-diff-find, .power-helm-operation-dialog',
        )
      )
        overlayEscapes.current.add(event);
    };
    window.addEventListener("keydown", captureEscape, true);
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        overlayEscapes.current.has(event) ||
        document.querySelector(
          '[data-testid="confirmation-dialog"], .Select__menu, .helm-release-actions-menu, .monaco-editor .find-widget.visible, .helm-diff-find, .power-helm-operation-dialog',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (previousScreen.current) previousScreen.current();
      else latestClose.current();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("click", captureEvent, true);
      window.removeEventListener("keydown", captureEvent, true);
      window.removeEventListener("keydown", captureEscape, true);
      document.removeEventListener("keydown", onEscape);
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  const [tab, setTab] = useState<HelmSection | "history">(historyRequest ? "history" : "overview");
  useEffect(() => {
    if (historyRequest) {
      setTab("history");
      setHistoricalRelease(undefined);
      setInitialCompare(false);
    }
  }, [historyRequest]);
  const [deployedRelease, setDeployedRelease] = useState<HelmReleaseMetadata>();
  useEffect(() => setDeployedRelease(undefined), [historyGeneration]);
  const [historicalRelease, setHistoricalRelease] = useState<HelmReleaseMetadata>();
  const [initialCompare, setInitialCompare] = useState(false);
  const [screens, setScreens] = useState<
    { tab: HelmSection | "history"; release?: HelmReleaseMetadata; compare: boolean }[]
  >([]);
  const navigate = (next: HelmSection | "history", historical?: HelmReleaseMetadata, compare = false) => {
    setScreens((items) => [...items, { tab, release: historicalRelease, compare: initialCompare }]);
    setTab(next);
    setHistoricalRelease(historical);
    setInitialCompare(compare);
  };
  previousScreen.current = screens.length
    ? () => {
        const previous = screens[screens.length - 1];
        setScreens((items) => items.slice(0, -1));
        setTab(previous.tab);
        setHistoricalRelease(previous.release);
        setInitialCompare(previous.compare);
      }
    : undefined;
  useEffect(() => {
    setHistoricalRelease(undefined);
    setInitialCompare(false);
  }, [release.revision, release.uid]);
  const viewedRelease = historicalRelease ?? release;
  useEffect(() => {
    if (tab !== "values" && tab !== "manifest") return;
    const onFind = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      const dialog = document.querySelector<HTMLElement>('[data-testid="confirmation-dialog"]');
      const container = dialog ? (dialog.querySelector(".helm-revision-diff") ? dialog : undefined) : panel.current;
      if (!container) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".helm-code-view") ||
          (!container.contains(target) && target.closest("input, textarea, select, [contenteditable=true]")))
      )
        return;
      if (openHelmDocumentFind(container)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onFind, true);
    return () => document.removeEventListener("keydown", onFind, true);
  }, [tab]);
  return (
    <Drawer
      open
      className="helm-native-drawer"
      contentClass="helm-native-drawer-content"
      testIdForClose="helm-release-close"
      title={`Helm release: ${release.name}`}
      onClose={() => {
        const event = currentEvent.current;
        if (event && overlayClicks.current.has(event)) return;
        if (event instanceof KeyboardEvent && (event.defaultPrevented || overlayEscapes.current.has(event))) return;
        if (
          event?.target instanceof Element &&
          event.target.closest(
            '.Select__menu, .helm-release-actions-menu, .power-helm-operation-dialog, [data-testid="confirmation-dialog"]',
          )
        )
          return;
        latestClose.current();
      }}
    >
      <aside ref={panel} tabIndex={-1} aria-label={`Release ${release.name}`} className="helm-panel">
        <div className="helm-panel-heading">
          <div>
            <div className="helm-panel-meta">
              <span>{release.namespace}</span>
              <span className="helm-version-badge">
                {historicalRelease ? "Viewing Revision" : "Revision"} {viewedRelease.revision}
              </span>
              <StatusBadge status={viewedRelease.status} />
              <ReleaseAppVersion clusterId={clusterId} contextId={contextId} release={viewedRelease} />
            </div>
          </div>
          <div className="helm-panel-actions">
            <HelmReleaseActions
              clusterId={clusterId}
              contextId={contextId}
              release={release}
              allowed={uninstallAllowed}
              onDeleted={close}
              onChanged={onChanged}
              onError={setDeleteError}
            />
          </div>
        </div>
        {deleteError && <InlineAlert>{deleteError}</InlineAlert>}
        {historicalRelease && (
          <div className="helm-viewing-banner">
            <span>Historical revision · Read only</span>
            <NativeTooltip title="Back to current">
              <button
                type="button"
                className="helm-icon-button"
                aria-label="Back to current"
                onClick={() => navigate(tab)}
              >
                <Icon material="keyboard_return" size={18} />
              </button>
            </NativeTooltip>
          </div>
        )}
        <nav
          className="helm-tabs"
          role="tablist"
          aria-label="Release sections"
          onKeyDown={(event) => {
            const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
            if (!keys.includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const index = tabs.indexOf(event.target);
            if (index < 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          {(["overview", "values", "manifest", "history", "notes"] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              id={`${tabIdentity}-${value}`}
              aria-controls={`${tabIdentity}-panel`}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              label={value[0].toUpperCase() + value.slice(1)}
              className={tab === value ? "helm-tab helm-tab-active" : "helm-tab"}
              onClick={() => {
                if (value !== tab) navigate(value, value === "history" ? undefined : historicalRelease);
              }}
            />
          ))}
        </nav>
        <div
          className="helm-panel-content"
          role="tabpanel"
          id={`${tabIdentity}-panel`}
          aria-labelledby={`${tabIdentity}-${tab}`}
        >
          {tab === "history" ? (
            <History
              generation={historyGeneration}
              clusterId={clusterId}
              contextId={contextId}
              release={release}
              onLatest={onLatest}
              onDeployed={setDeployedRelease}
              onView={(item, compare) =>
                navigate("values", item.revision !== release.revision ? item : undefined, compare)
              }
            />
          ) : (
            <Section
              key={`${tab}/${viewedRelease.revision}/${viewedRelease.uid ?? ""}/${initialCompare}`}
              clusterId={clusterId}
              contextId={contextId}
              release={viewedRelease}
              currentRelease={release}
              deployedRelease={deployedRelease}
              initialCompare={initialCompare}
              isOverlayEscape={(event) => overlayEscapes.current.has(event)}
              restoreControls={
                historicalRelease && (
                  <History
                    key={`restore/${historicalRelease.revision}/${historicalRelease.uid ?? ""}`}
                    clusterId={clusterId}
                    contextId={contextId}
                    release={release}
                    restoreTarget={historicalRelease}
                    generation={historyGeneration}
                    onLatest={onLatest}
                    onDeployed={setDeployedRelease}
                    onView={() => undefined}
                  />
                )
              }
              onChanged={onChanged}
              tab={tab}
            />
          )}
        </div>
      </aside>
    </Drawer>
  );
}

function Releases({
  clusterId,
  namespace,
  partition,
  namespaceFilter,
  pendingHistory,
  onViewHistory,
  onHistoryOpened,
}: {
  clusterId: string;
  namespace: string;
  partition: string;
  namespaceFilter: ReactNode;
  pendingHistory?: HelmOperation;
  onViewHistory: (operation: HelmOperation) => void;
  onHistoryOpened: () => void;
}) {
  const state = useHelmRequest({ clusterId, namespace, operation: "list" }, `${partition}/${namespace}`);
  const [search, setSearch] = useState("");
  const [versionGeneration, setVersionGeneration] = useState(0);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [search, status, state.result]);
  const releaseFrame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (releaseFrame.current) releaseFrame.current.scrollTop = 0;
  }, [page, search, status, state.result]);
  const [selection, setSelection] = useState<{
    release: HelmReleaseMetadata;
    result: Extract<HelmResponse, { ok: true }>;
    historyRequest?: number;
  }>();
  const result = state.result?.ok ? state.result : undefined;
  useEffect(() => {
    if (!pendingHistory || !result || state.loading || state.stale || result.contextId !== pendingHistory.contextId)
      return;
    const entry = result.releases?.find(
      (item) => item.name === pendingHistory.name && item.namespace === pendingHistory.namespace,
    );
    if (!entry) return;
    setSelection({ release: entry, result, historyRequest: Date.now() });
    onHistoryOpened();
  }, [pendingHistory, result, state.loading, state.stale, onHistoryOpened]);
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
    setSelection((previous) => {
      if (!previous || previous.result === result) return previous;
      if (previous.result.contextId !== result.contextId) return undefined;
      const entry = result.releases?.find(
        (item) => item.name === previous.release.name && item.namespace === previous.release.namespace,
      );
      return entry ? { ...previous, release: entry, result } : undefined;
    });
  }, [state.errorCode, selection, result, listedSelection]);
  const releases = (result?.releases ?? []).map((item) =>
    selected &&
    selected.name === item.name &&
    selected.namespace === item.namespace &&
    selected.revision > item.revision
      ? selected
      : item,
  );
  const initialLoading = state.loading && releases.length === 0;
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
          <HelmSearchField
            label="Search releases"
            placeholder="Search releases"
            value={search}
            onChange={setSearch}
            clearLabel="Clear release search"
          />
        </label>
        <label className="helm-filter helm-status-filter">
          <span>Status</span>
          <Select
            aria-label="Release status"
            isSearchable={false}
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
          {initialLoading
            ? "Releases"
            : filtered.length !== releases.length
              ? `${filtered.length} of ${releases.length} releases`
              : `${filtered.length} ${filtered.length === 1 ? "release" : "releases"}`}
        </span>
        {!initialLoading && (
          <RequestStatus
            state={{
              ...state,
              refresh: () => {
                setVersionGeneration((value) => value + 1);
                state.refresh();
              },
            }}
          />
        )}
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
      {initialLoading && (
        <div className="helm-initial-loading" role="region" aria-label="Helm releases table">
          <RequestStatus state={state} loadingLabel="Loading Helm releases and their current status…" />
        </div>
      )}
      {!initialLoading && (filtered.length > 0 || state.loading || state.error) && (
        <div
          ref={releaseFrame}
          className="helm-table-frame"
          role="region"
          aria-label="Helm releases table"
          tabIndex={0}
        >
          <table className="helm-table">
            <thead>
              <tr>
                {["Name", "Status", "Namespace", "App version", "Revision", "Metadata updated"].map((title) => (
                  <th key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(page * 100, (page + 1) * 100).map((release) => (
                <tr
                  key={`${release.namespace}/${release.name}`}
                  className="helm-release-row"
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      window.getSelection()?.toString() ||
                      (event.target instanceof Element &&
                        event.target.closest("button, a, input, select, textarea") &&
                        !event.target.closest(".helm-release-link"))
                    )
                      return;
                    event.preventDefault();
                    event.currentTarget
                      .querySelector<HTMLButtonElement>(".helm-release-link")
                      ?.focus({ preventScroll: true });
                    if (result) setSelection({ release, result });
                  }}
                >
                  <td>
                    <NativeTooltip title={release.name}>
                      <Button
                        className="helm-release-link"
                        label={release.name}
                        onMouseDown={(event) => {
                          if (event.button === 0) event.preventDefault();
                        }}
                      />
                    </NativeTooltip>
                  </td>
                  <td>
                    <StatusBadge status={release.status} />
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
                  <td>
                    <span className="helm-version-badge">{release.revision}</span>
                  </td>
                  <td>
                    <ReleaseTimestamp value={release.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > 100 && (
        <HelmPagination page={page} pages={Math.ceil(filtered.length / 100)} kind="releases" onChange={setPage} />
      )}
      {!state.loading && !state.error && !filtered.length && (
        <div className="helm-empty">
          <Icon material={search || status ? "search" : "inbox"} size={28} />
          <p>
            {search &&
            (versionIndex.completed < versionIndex.total || versionIndex.errors > 0 || versionIndex.truncated)
              ? "No known matches"
              : search || status
                ? "No releases found"
                : "No Helm releases"}
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
                : namespace
                  ? `No Helm releases in ${namespace}`
                  : "No Helm releases in the available namespaces"}
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
      <HelmOperationsPanel
        clusterId={clusterId}
        contextId={result?.contextId}
        onChanged={state.refresh}
        onViewHistory={(operation: HelmOperation) => {
          onViewHistory(operation);
          if (namespace === operation.namespace) state.refresh();
        }}
      />
      {selectedRelease && (
        <ReleasePanel
          key={`${selectedRelease.namespace}/${selectedRelease.name}/${state.result?.ok ? state.result.contextId : ""}`}
          clusterId={clusterId}
          contextId={state.result?.ok ? state.result.contextId : undefined}
          release={selectedRelease}
          uninstallAllowed={Boolean(result?.uninstallAllowed && !state.stale && !state.loading && !state.error)}
          close={() => setSelection(undefined)}
          onChanged={state.refresh}
          historyGeneration={historyGeneration.current.id}
          historyRequest={selection?.historyRequest}
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
  const [pendingHistory, setPendingHistory] = useState<HelmOperation>();
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
      pendingHistory={pendingHistory}
      onHistoryOpened={() => setPendingHistory(undefined)}
      onViewHistory={(operation) => {
        setPendingHistory(operation);
        setNamespace(operation.namespace);
      }}
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
        .power-helm .helm-pagination { justify-content: flex-end; gap: 8px; }
        .power-helm .helm-pagination button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 3px; border: 1px solid var(--borderColor); border-radius: 4px; color: var(--textColorSecondary); background: var(--contentColor); cursor: pointer; }
        .power-helm .helm-pagination button:not(:disabled):hover { color: var(--primary); border-color: var(--primary); }
        .power-helm .helm-pagination button:disabled { opacity: .45; cursor: default; }
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
        .power-helm .helm-search-field { position: relative; min-width: 0; }
        .power-helm .helm-search-field > input { width: 100%; padding-right: 34px; }
        .power-helm .helm-search-clear { position: absolute; top: 1px; right: 1px; height: 30px; width: 30px; border: 0; border-radius: 3px; background: transparent; color: var(--textColorSecondary); display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .power-helm .helm-search-clear:hover { background: var(--contentColor); color: var(--textColorPrimary); }
        :root .power-helm :is(.helm-filters, .helm-comparison-toolbar) .Select .Select__control { border: 1px solid var(--borderColor); box-shadow: none !important; }
        :root .power-helm :is(.helm-filters, .helm-comparison-toolbar) .Select:not(.Select--is-disabled) .Select__control--is-focused:not(.Select__control--is-disabled) { border-color: var(--primary) !important; box-shadow: inset 0 0 0 1px var(--primary) !important; }
        .power-helm .helm-text-input { box-sizing: border-box; height: 32px; color: var(--textColorPrimary); background: var(--inputControlBackground, var(--mainBackground)); border: 1px solid var(--borderColor); border-radius: 4px; padding: 6px 10px; font: inherit; }
        .power-helm .helm-text-input:focus-visible, .power-helm input[type=radio]:focus-visible, .power-helm button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-helm input[type=checkbox], .power-helm input[type=radio] { accent-color: var(--primary); margin: 0 7px 0 0; vertical-align: middle; }
        .power-helm .helm-native-button, .power-helm .helm-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; color: var(--textColorSecondary); border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
        .power-helm .helm-native-button:hover, .power-helm .helm-icon-button:hover { color: var(--textColorPrimary); background: var(--contentColor); }
        .power-helm .helm-list-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; align-items: center; margin: 6px 0 10px; }
        .power-helm .helm-chart-source-loading { display: flex; align-items: center; justify-content: center; min-height: 68px; }
        .power-helm .helm-chart-source-loading .helm-request-status { justify-content: center; }
        .power-helm .helm-comparison-restore { flex-shrink: 0; }
        .power-helm .helm-comparison-loading { display: flex; flex: 1; min-height: 140px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--textColorSecondary); }
        .power-helm .helm-comparison-loading .helm-request-status { justify-content: center; }
        .power-helm .helm-initial-loading { display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: 120px; padding: 28px; border: 1px dashed var(--borderColor); border-radius: 8px; color: var(--textColorSecondary); }
        .power-helm .helm-initial-loading .helm-request-status { justify-content: center; }
        .power-helm .helm-request-status[data-error=true] { border: 1px solid color-mix(in srgb, var(--colorError) 35%, var(--borderColor)); background: var(--contentColor); border-radius: 6px; padding: 12px; justify-content: space-between; }
        .power-helm .helm-request-status[data-error=true] .helm-error { flex: 1 1 200px; min-width: 0; align-items: flex-start; line-height: 1.5; }
        .power-helm .helm-request-status[data-error=true] .Icon { flex-shrink: 0; }
        .power-helm .helm-request-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 30px; }
        .power-helm .helm-panel-content > .helm-request-status { justify-content: flex-end; margin-bottom: 12px; }
        .power-helm .helm-request-compact:not([data-error=true]) { width: 32px; min-width: 32px; flex-wrap: nowrap; justify-content: flex-end; gap: 4px; }
        .power-helm .helm-loading-cancel .helm-cancel-icon { display: none; }
        .power-helm .helm-loading-cancel:is(:hover, :focus-visible) .helm-spinner { display: none; }
        .power-helm .helm-loading-cancel:is(:hover, :focus-visible) .helm-cancel-icon { display: inline-flex; }
        .power-helm .helm-request-compact .helm-loading { order: 1; justify-content: center; width: 30px; height: 30px; }
        .power-helm .helm-request-compact .helm-spinner .Icon { --size: 18px; }
        .power-helm .helm-notes-state { width: 100%; }
        .power-helm .helm-notes-section > .helm-request-status { justify-content: flex-end; min-height: 32px; margin-bottom: 12px; }
        .power-helm .helm-notes-state > .helm-request-status { justify-content: flex-end; min-height: 32px; }
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
        .power-helm .helm-version-progress .Button { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 6px; }
        .power-helm .helm-app-version-cell { display: inline-flex; align-items: center; min-width: 24px; }
        .power-helm .helm-app-version-placeholder { color: var(--textColorSecondary); opacity: .55; }
        .power-helm .helm-app-version-retry { display: inline-flex; padding: 0; background: transparent; border: 0; color: var(--textColorSecondary); cursor: pointer; }
        .power-helm .helm-app-version-retry:hover, .power-helm .helm-app-version-retry:focus-visible { color: var(--primary); }
        .power-helm .helm-table-frame { flex: 0 1 auto; min-height: 0; border: 1px solid var(--borderColor); border-radius: 6px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: auto; }
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
        :root .power-helm .Button.helm-release-link::before { display: none; }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status { display: inline-flex; white-space: nowrap; box-sizing: border-box; height: 22px; align-items: center; font-size: 12px; line-height: 18px; padding: 1px 7px; border-radius: 4px; color: var(--textColorSecondary); background: var(--contentColor); border: 1px solid var(--borderColor); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=deployed] { color: var(--colorOk, var(--textColorAccent)); background: color-mix(in srgb, var(--colorOk, var(--primary)) 9%, var(--mainBackground)); border-color: color-mix(in srgb, var(--colorOk, var(--primary)) 25%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=failed] { color: var(--colorError); border-color: color-mix(in srgb, var(--colorError) 30%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status^=pending-], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalling] { color: var(--colorWarning, var(--textColorAccent)); background: color-mix(in srgb, var(--colorWarning, var(--primary)) 9%, var(--mainBackground)); border-color: color-mix(in srgb, var(--colorWarning, var(--primary)) 30%, var(--borderColor)); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=superseded], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalled], :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=unknown] { color: var(--textColorSecondary); background: var(--contentColor); }
        :is(.power-helm, .power-helm-confirmation, .helm-status-menu) .helm-status[data-status=uninstalled] { border-style: dashed; }
        .power-helm .helm-native-drawer { max-width: 95%; }
        .power-helm .helm-native-drawer:has(.helm-comparison-active) { width: min(1100px, calc(100% - 24px)); }
        .power-helm .helm-native-drawer-content { padding: 0; overflow: hidden; min-height: 0; }
        .power-helm .helm-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; outline: none; }
        .power-helm .helm-release-row { cursor: pointer; }
        :root .power-helm .Button.helm-release-link:focus:not(:focus-visible) { outline: none; box-shadow: none; }
        .power-helm .helm-panel-actions { display: flex; align-items: center; gap: 4px; }
        .helm-release-actions-menu { max-height: min(360px, 70vh); overflow-y: auto; }
        .helm-release-actions-menu .MenuItem { gap: 8px; }
        :root .helm-release-actions-menu .MenuItem { --bgc-active: var(--primary); --color-active: var(--buttonPrimaryColor, white); }
        :root .helm-release-actions-menu .MenuItem.helm-release-delete-action { --bgc-active: var(--colorError); }
        .power-helm .helm-panel-heading { flex-shrink: 0; background: var(--mainBackground); display: flex; justify-content: space-between; align-items: start; padding: 22px 15.5px 18px 22px; gap: 12px; }
        .power-helm .helm-panel-heading h2 { overflow-wrap: anywhere; }
        .power-helm .helm-native-drawer:has(.helm-comparison-active) .helm-panel-heading { padding-top: 10px; padding-bottom: 6px; }
        .power-helm .helm-panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 8px; }
        .power-helm .helm-tabs { flex-shrink: 0; background: var(--mainBackground); display: flex; overflow-x: auto; padding: 0 18px; gap: 4px; border-bottom: 1px solid var(--borderColor); }
        :root .power-helm .Button.helm-tab { background: transparent; border: 0; border-radius: 0; padding: 12px 8px; color: var(--textColorSecondary); white-space: nowrap; box-shadow: none; border-bottom: 2px solid transparent; }
        :root .power-helm .Button.helm-tab:focus-visible { outline: 2px solid var(--primary); outline-offset: -4px; }
        :root .power-helm .Button.helm-tab-active { color: var(--textColorPrimary); border-bottom-color: var(--primary); }
        .power-helm .helm-panel-content { min-height: 0; overflow: auto; flex: 1; padding: 18px 22px 24px; }
        .power-helm .helm-panel-content:has(> .helm-comparison-active) { padding-top: 8px; }
        .power-helm .helm-overview-card { border: 1px solid var(--borderColor); border-radius: 6px; overflow: hidden; }
        .power-helm .helm-overview-card > header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 6px 12px 6px 16px; background: var(--contentColor); border-bottom: 1px solid var(--borderColor); }
        .power-helm .helm-overview-card h3 { margin: 0; font-size: 12px; font-weight: 500; }
        .power-helm .helm-overview > [data-field="Revision"] { grid-area: 1 / 1; }
        .power-helm .helm-overview > [data-field="App version"] { grid-area: 2 / 1; }
        .power-helm .helm-overview > [data-field="Chart version"] { grid-area: 3 / 1; }
        .power-helm .helm-overview > [data-field="Name"] { grid-area: 1 / 2; }
        .power-helm .helm-overview > [data-field="Namespace"] { grid-area: 2 / 2; }
        .power-helm .helm-overview > [data-field="Status"] { grid-area: 3 / 2; }
        .power-helm .helm-overview { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; padding: 0 16px; }
        .power-helm .helm-overview > div { display: flex; flex-direction: column; gap: 7px; min-width: 0; padding: 15px 0; border-bottom: 1px solid var(--borderColor); }
        .power-helm .helm-overview > div:last-child { border: 0; }
        .power-helm .helm-overview dt { color: var(--textColorSecondary); font-size: 11px; }
        .power-helm .helm-overview .helm-overview-description { grid-column: 1 / -1; }
        .power-helm .helm-overview dd { font-size: 13px; line-height: 1.5; }
        .power-helm .helm-overview dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
        :is(.power-helm, .power-helm-confirmation) .helm-version-badge { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 22px; padding: 1px 7px; border: 1px solid color-mix(in srgb, var(--primary) 25%, var(--borderColor)); border-radius: 4px; background: color-mix(in srgb, var(--primary) 12%, transparent); color: var(--primary); font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap; vertical-align: middle; }
        .power-helm .helm-edit-notice { display: flex; align-items: start; gap: 10px; padding: 12px; border: 1px solid var(--borderColor); border-radius: 4px; margin-bottom: 12px; }
        .power-helm .helm-edit-notice p { margin-top: 5px; color: var(--textColorSecondary); font-size: 12px; line-height: 1.5; }
        .power-helm .helm-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .power-helm .helm-release-app-version { display: inline-flex; align-items: center; gap: 6px; }
        .power-helm .helm-values-editor > .helm-request-status { margin-bottom: 16px; }
        .power-helm .helm-panel-content:has(> .helm-document-section) { display: flex; overflow: hidden; }
        .power-helm .helm-document-section > .helm-revision-diff { display: flex; flex-direction: column; min-height: 0; flex: 1; }
        .power-helm .helm-document-section > .helm-revision-diff > .helm-diff-scroll { flex: 1; min-height: 0; max-height: none; }
        .power-helm .helm-document-section > .helm-revision-diff > :not(.helm-diff-scroll) { flex-shrink: 0; }
        .power-helm .helm-document-section, .power-helm .helm-values-editor { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
        .power-helm .helm-chart-source-status { margin-bottom: 12px; }
        .power-helm .helm-document-section > :not(.helm-code-view):not(.helm-values-editor):not(.helm-revision-diff), .power-helm .helm-values-editor > :not(.helm-code-view) { flex-shrink: 0; }
        :root .power-helm .helm-copy-action .Button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; box-sizing: border-box; padding: 0 10px; line-height: 1; }
        :root .power-helm .Button::before { position: absolute; inset: 0; pointer-events: none; }
        .power-helm .helm-copy-action .Button > .Icon { flex-shrink: 0; margin: 0; padding: 0; }
        .power-helm .helm-copy-action .helm-icon-button { width: 32px; height: 32px; }
        .power-helm .helm-values-editor > .helm-filter { margin: 0 0 12px; }
        .power-helm .helm-values-editor > .helm-toolbar { position: sticky; bottom: -24px; z-index: 4; margin: 12px -22px -24px; padding: 12px 22px; justify-content: flex-end; border-top: 1px solid var(--borderColor); background: var(--mainBackground); box-shadow: 0 -6px 12px color-mix(in srgb, var(--mainBackground) 70%, transparent); }
        .power-helm .helm-revision-notice, .power-helm .helm-viewing-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; color: var(--textColorSecondary); font-size: 12px; padding: 10px 12px; border: 1px solid var(--borderColor); border-radius: 4px; }
        .power-helm .helm-viewing-banner { margin: 0 22px 4px; padding: 4px 0; min-height: 38px; box-sizing: border-box; border: 0; }
        .power-helm .helm-viewing-banner > span { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .power-helm .helm-comparison-toolbar { align-items: center; gap: 8px; margin: 0 0 8px; }
        :root .power-helm .helm-comparison-toolbar .Button { height: 32px; box-sizing: border-box; }
        :root .power-helm .Button.helm-comparison-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box; height: 32px; }
        .power-helm .helm-comparison-baseline { flex-direction: row; align-items: center; gap: 8px; min-width: 0; max-width: 360px; flex: 1; }
        .power-helm .helm-comparison-baseline > span { white-space: nowrap; }
        .power-helm .helm-comparison-baseline > .Select { flex: 1; min-width: 140px; }
        .power-helm .helm-current-baseline { display: block; margin-top: 4px; }
        .power-helm .helm-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
        .power-helm .helm-code-header + .helm-code-view { border: 1px solid var(--borderColor); border-top: 0; border-radius: 0 0 6px 6px; }
        .power-helm .helm-code-view { overscroll-behavior: contain; }
        .power-helm .helm-notes-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 16px; color: var(--textColorSecondary); text-align: center; }
        .power-helm .helm-notes-empty strong { font-size: 14px; font-weight: 500; color: var(--textColorPrimary); }
        .power-helm .helm-timestamp { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .power-helm .helm-copy-action { display: inline-flex; align-items: center; gap: 8px; }
        .power-helm .helm-code-header > span:first-child { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 10px; }
        .power-helm .helm-code-header { display: flex; justify-content: space-between; align-items: center; background: var(--contentColor); border: 1px solid var(--borderColor); border-radius: 6px 6px 0 0; padding: 8px 12px; color: var(--textColorSecondary); font-size: 12px; }
        .power-helm pre.helm-notes { max-height: 52vh; overscroll-behavior: contain; color: var(--textColorPrimary); background: var(--mainBackground); }
        .power-helm pre.helm-notes code { color: inherit; opacity: 1; background: transparent; }
        .power-helm pre { margin: 0; padding: 16px; font-size: 12px; line-height: 1.65; border: 1px solid var(--borderColor); border-top: 0; border-radius: 0 0 6px 6px; max-height: 65vh; overflow: auto; }
        .power-helm .helm-panel-content:has(> .helm-history-layout) { display: flex; overflow: hidden; }
        .power-helm .helm-access-badge { box-sizing: border-box; height: 22px; display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid var(--borderColor); border-radius: 4px; color: var(--textColorSecondary); font-size: 11px; white-space: nowrap; }
        .power-helm .helm-history-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
        .power-helm .helm-history-delete:not(:disabled):is(:hover, :focus-visible) { color: var(--colorError); background: color-mix(in srgb, var(--colorError) 12%, transparent); }
        .power-helm .helm-history-revision { display: flex; align-items: center; gap: 7px; min-height: 30px; }
        .power-helm .helm-revision-cell { position: relative; }
        .power-helm .helm-history-revision:has(.helm-revision-select) { padding-left: 24px; }
        .power-helm .helm-revision-select { display: inline-flex; align-items: center; justify-content: center; position: absolute; inset: 0 auto 0 0; width: 34px; cursor: pointer; }
        .power-helm .helm-revision-select:has(input:disabled) { cursor: default; }
        .power-helm .helm-history-revision .helm-current-tag { margin-left: 0; }
        .power-helm .helm-history-layout { display: flex; flex-direction: column; min-height: 0; width: 100%; flex: 1; }
        .power-helm .helm-history-layout > :not(.helm-history-frame) { flex-shrink: 0; }
        .power-helm .helm-history-tools { margin: 0 0 12px; gap: 8px; }
        .power-helm .helm-history-tools > .helm-search-field { width: 180px; min-width: 140px; flex: 1; }
        .power-helm .helm-history-refresh { margin-left: auto; }
        .power-helm .helm-history-layout > .helm-request-status { justify-content: flex-end; margin-bottom: 12px; }
        .power-helm .helm-history-frame { flex: 0 1 auto; min-height: 80px; overflow: auto; border: 1px solid var(--borderColor); border-radius: 6px; overscroll-behavior: contain; scrollbar-gutter: auto; }
        .power-helm .helm-history-frame:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-helm .helm-history-table { font-size: 12px; }
        .power-helm .helm-history-table tbody tr[aria-disabled=false] { cursor: pointer; }
        .power-helm .helm-history-table tbody tr:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
        .power-helm .helm-history-table th, .power-helm .helm-history-table td { padding: 8px 10px; white-space: nowrap; }
        :root .power-helm .Button.helm-rollback-button { display: inline-flex; align-items: center; gap: 6px; }
        :root .power-helm .Button.helm-rollback-button:not(:disabled) { color: var(--textColorAccent); border-color: var(--primary); }
        .power-helm .helm-history-view:not(:disabled):hover, .power-helm .helm-history-view:focus-visible { color: var(--primary); }
        .power-helm .helm-history-view:disabled { opacity: .45; cursor: default; background: transparent; }
        .power-helm .helm-history-table .helm-inline-action { white-space: nowrap; font-size: 12px; }
        .power-helm .helm-history-table input[type=radio] { appearance: none; flex-shrink: 0; margin: 0; width: 14px; height: 14px; border: 1px solid var(--textColorSecondary); border-radius: 50%; background: var(--mainBackground); cursor: pointer; }
        .power-helm .helm-history-table input[type=radio]:checked { background: var(--primary); border-color: var(--primary); box-shadow: inset 0 0 0 3px var(--mainBackground); }
        .power-helm .helm-history-table input[type=radio]:disabled { opacity: .45; cursor: default; }
        .power-helm .helm-consent { position: relative; }
        .power-helm .helm-consent input[type=checkbox] { display: block; position: absolute; left: 0; top: 50%; width: 14px; height: 14px; transform: translateY(-50%); opacity: 0; margin: 0; z-index: 1; }
        .power-helm .helm-consent input:focus-visible ~ .box { outline: 2px solid var(--primary); outline-offset: 3px; }
        .power-helm .helm-consent-target { display: inline; line-height: 1.8; overflow-wrap: anywhere; }
        .power-helm .helm-consent-target strong { font-weight: 500; }
        .power-helm .helm-consent-revision { margin: 0 4px; }
        .power-helm .helm-consent-version { display: inline-block; color: var(--textColorSecondary); font-size: 11px; white-space: nowrap; }
        .power-helm .helm-current-tag { box-sizing: border-box; height: 22px; display: inline-flex; align-items: center; margin-left: 7px; padding: 2px 6px; border-radius: 3px; background: var(--contentColor); border: 1px solid var(--borderColor); color: var(--textColorSecondary); font-size: 11px; line-height: 16px; vertical-align: middle; }
        :root .power-helm .Button.helm-inline-action:not(.helm-history-view) { border-color: transparent; background: transparent; color: var(--primary); padding: 4px 6px; }
        .power-helm .helm-history-table label { cursor: pointer; display: inline-flex; align-items: center; gap: 7px; margin: 0; }
        .power-helm .helm-rollback { margin-top: 8px; padding: 8px 12px; min-height: 0; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--colorWarning, var(--primary)) 35%, var(--borderColor)); border-radius: 6px; }
        .power-helm .helm-rollback-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 4px; }
        .power-helm .helm-rollback-controls > .Button { min-height: 30px; white-space: nowrap; }
        .power-helm .helm-rollback-controls .helm-consent { margin: 0; min-height: 32px; }
        .power-helm .helm-restore-revision { flex-shrink: 0; margin-bottom: 8px; }
        .power-helm .helm-restore-revision > .helm-request-status { margin-bottom: 8px; }
        .power-helm .helm-restore-revision .helm-rollback { min-height: 0; margin-top: 0; padding: 8px 12px; background: color-mix(in srgb, var(--colorWarning, var(--primary)) 5%, transparent); }
        .power-helm .helm-restore-revision .helm-rollback-title { flex-wrap: wrap; }
        .power-helm .helm-restore-revision .helm-rollback-title > .helm-request-status { margin-left: auto; font-weight: 400; }
        .power-helm .helm-restore-revision .helm-rollback-title > .helm-request-status > .helm-icon-button { order: 1; }
        .power-helm .helm-restore-revision .helm-confirmation-target { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; font-size: 11px; font-weight: 400; }
        .power-helm .helm-restore-revision .helm-rollback-controls { margin-top: 6px; }
        .power-helm .helm-rollback-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-weight: 500; }
        .power-helm .helm-rollback-hint { color: var(--textColorSecondary); font-size: 12px; font-weight: 400; }
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
        .ConfirmDialog .helm-revision-badge { min-width: 28px; }
        .ConfirmDialog .helm-target-version, .ConfirmDialog .helm-confirmation-explanation { color: var(--textColorSecondary); font-size: 12px; }
        .ConfirmDialog .helm-target-version { display: inline-flex; align-items: center; gap: 8px; }
        .ConfirmDialog .helm-confirmation-heading { position: sticky; top: 0; z-index: 3; background: var(--contentColor); padding-bottom: 12px; }
        .ConfirmDialog:has(.power-helm-confirmation .helm-revision-diff) .power-helm-confirmation { overscroll-behavior: contain; scrollbar-gutter: stable; flex: 1; min-width: 0; max-height: 66vh; overflow: auto; padding-right: 4px; }

        .ConfirmDialog:has(.power-helm-confirmation) .confirm-content > .Icon { flex-shrink: 0; margin: 0; }
        .ConfirmDialog:has(.power-helm-confirmation) .power-helm-confirmation { display: block; line-height: 1.6; overflow-wrap: anywhere; color: var(--textColorPrimary); }
        .ConfirmDialog:has(.power-helm-confirmation) .power-helm-confirm { background: var(--colorError, #c64b4b); color: white; }
        .ConfirmDialog:has(.helm-rollback-confirmation) .confirm-content { align-items: flex-start; }
        .ConfirmDialog:has(.helm-rollback-confirmation) .confirm-content > .Icon { color: var(--primary); margin-top: 2px; }
        .ConfirmDialog:has(.helm-rollback-confirmation) .power-helm-confirm-rollback { display: inline-flex; align-items: center; gap: 6px; background: var(--primary); border-color: var(--primary); color: var(--buttonPrimaryColor, white); }
        .ConfirmDialog:has(.helm-rollback-confirmation) .power-helm-confirm-rollback > .Icon { margin: 0; padding: 0; }
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
