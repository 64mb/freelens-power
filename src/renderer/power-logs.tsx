import { randomUUID } from "node:crypto";
import { Renderer } from "@freelensapp/extensions";
import { clipboard } from "electron";
import { observer } from "mobx-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatDateTime } from "../common/date-time";
import {
  compileJsonFilters,
  type JsonFieldFilter,
  type JsonPath,
  jsonValuesEqual,
} from "../common/power-log-field-filters";
import { buildJsonFilterSql, type SqlJsonFieldFilter } from "../common/power-log-json-filter-sql";
import { buildJsonProjectionSql, JSON_KEY_DISCOVERY_SQL } from "../common/power-log-json-preset";
import { sqlCellLevel } from "../common/power-log-sql-level";
import {
  POWER_LOGS_LIMITS as L,
  type LogCapture,
  type LogLevel,
  type LogQueryResult,
  type LogRecord,
  type LogSource,
  type LogTarget,
  POWER_LOGS_CHANNEL,
  POWER_LOGS_STORAGE_FULL,
} from "../common/power-logs";
import { powerLogLineEvidence, powerLogQueryEvidence } from "../common/power-logs-ai";
import { applyPowerLogsLimits, normalizePowerLogsLimits } from "../common/power-logs-limits";
import { LogsPreferencesStore } from "../common/store/logs-preferences-store";
import { explainDiagnosticFinding } from "./ai-diagnostic-handoff";
import { DiagnosticExplainButton } from "./diagnostic-explain-button";
import { NativeTooltip } from "./native-tooltip";
import { createLogColumnSizer } from "./power-log-column-widths";
import { createLogColumnReader, logColumnLabel, logColumnNames } from "./power-log-columns";
import { LogJson } from "./power-log-json";
import { LogJsonCell } from "./power-log-json-cell";
import { formatJsonLiteral, jsonHasDuplicateKeys } from "./power-log-json-fields";
import { LogMessage } from "./power-log-message";
import { SqlEditor } from "./power-log-sql-editor";
import { powerLogsStyles } from "./power-logs.css";
import { createPowerLogsClient } from "./power-logs-client";
import { collectHistoricalLogs, type LiveLogCoverage, resolveLogSources, startLiveLogs } from "./power-logs-collector";
import { withLogContext } from "./power-logs-context";
import { openPowerLogs, parsePowerLogsTarget } from "./power-logs-entrypoints";
import { type LogResourceStoresState, subscribeLogResourceStores } from "./power-logs-resource-stores";
import { CaptureSqlDrafts } from "./power-logs-sql-drafts";
import { sqlRowDetails } from "./power-logs-sql-row";
import { createPowerLogsTransport } from "./power-logs-transport";
import { searchContextId } from "./resource-search-client";

const Icon = (props: { material: string; size?: number; tooltip?: string }) => (
  <span aria-hidden="true" style={{ display: "inline-flex" }}>
    <Renderer.Component.Icon {...props} />
  </span>
);
const sourceKey = (r: Pick<LogRecord, "pod" | "container" | "previous">) =>
  `${r.pod} / ${r.container}${r.previous ? " (previous)" : ""}`;
const storageFull = (error: unknown) =>
  error instanceof Error &&
  (error.message === POWER_LOGS_STORAGE_FULL ||
    error.message === `Error invoking remote method '${POWER_LOGS_CHANNEL}': Error: ${POWER_LOGS_STORAGE_FULL}`);
const levels: LogLevel[] = ["trace", "debug", "info", "access", "warn", "error", "fatal", "unknown"];
const examples = [
  ["Recent", "SELECT timestamp, level, message, container, pod FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200"],
  [
    "Errors",
    "SELECT message, count(*) AS occurrences FROM logs WHERE level IN ('error','fatal') GROUP BY message ORDER BY occurrences DESC LIMIT 200",
  ],
  [
    "Timeline",
    "SELECT (timestamp / 60000) * 60000 AS minute, UPPER(level) AS level, count(*) AS lines FROM logs GROUP BY minute, level ORDER BY minute",
  ],
  ["JSON", "SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100"],
] as const;
const sqlColumnWidth = (column: string) =>
  column === "message" || column === "fieldsJson" ? 360 : column === "level" ? 90 : 200;
type ViewRecord = LogRecord & { key: number; bytes: number };

function initialTarget(): LogTarget | undefined {
  try {
    return parsePowerLogsTarget(JSON.parse(new URLSearchParams(window.location.search).get("target") ?? "null"));
  } catch {
    return;
  }
}
function initialSource(container: unknown = new URLSearchParams(window.location.search).get("container")): string {
  return typeof container === "string" && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(container) && container.length <= 63
    ? `container:${container}`
    : "";
}

function LogSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  renderOption,
  onKeyDown,
}: {
  id?: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  renderOption?: (option: { value: string; label: string }, context: "menu" | "value") => ReactNode;
}) {
  return (
    <span id={id} className="power-logs-select" data-source-select={label === "Container source" || undefined}>
      <Renderer.Component.Select
        aria-label={label}
        value={value}
        options={options}
        formatOptionLabel={(option, meta) =>
          renderOption ? (
            renderOption(option, meta.context)
          ) : label === "Log level" && option.value ? (
            <span className="power-logs-level-label" data-level={option.value}>
              {option.label}
            </span>
          ) : (
            option.label
          )
        }
        isDisabled={disabled}
        onKeyDown={onKeyDown}
        tabSelectsValue={false}
        isClearable={false}
        menuPosition="fixed"
        menuPortalTarget={document.body}
        styles={{
          menu: (base) => (label === "Container source" ? { ...base, width: "100%", maxWidth: "100%" } : base),
          menuList: (base) => (label === "Container source" ? { ...base, width: "100%", maxWidth: "100%" } : base),
          option: (base) => (label === "Container source" ? { ...base, whiteSpace: "normal" } : base),
          menuPortal: (base) => {
            if (label !== "Container source" && label !== "Capture snapshot") return { ...base, zIndex: 10000 };
            const width = Math.min(label === "Capture snapshot" ? 620 : 560, window.innerWidth - 32);
            return {
              ...base,
              zIndex: 10000,
              width,
              left: Math.max(
                16,
                Math.min(typeof base.left === "number" ? base.left : 16, window.innerWidth - width - 16),
              ),
            };
          },
        }}
        onChange={(option) => {
          if (option) onChange(option.value);
        }}
      />
    </span>
  );
}

const SourcePicker = observer(() => {
  const [loadState, setLoadState] = useState<LogResourceStoresState>({ loading: true, failed: false });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const stores = useMemo(
    () => [
      Renderer.K8sApi.podsStore,
      Renderer.K8sApi.deploymentStore,
      Renderer.K8sApi.daemonSetStore,
      Renderer.K8sApi.statefulSetStore,
      Renderer.K8sApi.replicaSetStore,
      Renderer.K8sApi.jobStore,
      Renderer.K8sApi.cronJobStore,
    ],
    [],
  );
  useEffect(
    () =>
      subscribeLogResourceStores(
        stores,
        (callback) => Renderer.K8sApi.namespaceStore.onContextChange(callback),
        Renderer.K8sApi.namespaceStore,
        setLoadState,
      ),
    [stores, loadAttempt],
  );
  const targets = stores.flatMap((store) =>
    store.contextItems.flatMap((object) => {
      const target = parsePowerLogsTarget({ kind: object.kind, ...object.metadata });
      return target ? [target] : [];
    }),
  );
  const [value, setValue] = useState("");
  const sorted = [...targets].sort(
    (a, b) =>
      Number(a.kind === "Pod") - Number(b.kind === "Pod") ||
      `${a.namespace}/${a.kind}/${a.name}`.localeCompare(`${b.namespace}/${b.kind}/${b.name}`),
  );
  return (
    <>
      <div className="power-logs-source">
        <label htmlFor="power-logs-resource-namespace" className="power-logs-control-label">
          Namespace
        </label>
        <div className="power-logs-resource-namespace">
          <Renderer.Component.NamespaceSelectFilter id="power-logs-resource-namespace" />
        </div>
        <span className="power-logs-control-label">Resource</span>
        <LogSelect
          label="Resource"
          value={value}
          disabled={loadState.loading && targets.length === 0}
          onChange={setValue}
          options={[
            { value: "", label: loadState.loading ? "Loading pods and workloads…" : "Choose a pod or workload" },
            ...sorted.map((target) => ({
              value: target.uid,
              label: `${target.namespace} / ${target.kind} / ${target.name}`,
            })),
          ]}
        />
        <button
          type="button"
          disabled={!targets.some((target) => target.uid === value)}
          onClick={() => {
            const target = targets.find((t) => t.uid === value);
            if (target) openPowerLogs(target);
          }}
        >
          <Icon material="subject" size={16} /> Open logs
        </button>
      </div>
      {(loadState.loading || loadState.failed || targets.length === 0) && (
        <div className="power-logs-muted" role="status">
          {loadState.loading
            ? "Loading resources in the current namespace selection…"
            : loadState.failed
              ? "Could not load some resources. Available results may be incomplete."
              : "No pods or workloads found in the current namespace selection."}
          {!loadState.loading && (
            <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              <Icon material="refresh" size={16} /> Retry loading resources
            </button>
          )}
        </div>
      )}
    </>
  );
});

function LogRows({
  records,
  loading,
  selected,
  onSelect,
  follow,
  setFollow,
  compact,
  matches,
  expanded,
  onToggleContext,
  contextAnchor,
  columnPaths,
  onToggleColumn,
}: {
  records: ViewRecord[];
  loading: boolean;
  selected?: number;
  onSelect(record: ViewRecord): void;
  follow: boolean;
  setFollow(value: boolean): void;
  compact: boolean;
  matches?: ReadonlySet<ViewRecord>;
  expanded: ReadonlySet<number>;
  onToggleContext(record: ViewRecord): void;
  contextAnchor?: { key: number };
  columnPaths: readonly JsonPath[];
  onToggleColumn(path: JsonPath): void;
}) {
  const columnNames = useMemo(() => logColumnNames(columnPaths), [columnPaths]);
  const readColumn = useMemo(() => createLogColumnReader(), []);
  const sizeColumns = useMemo(() => createLogColumnSizer(readColumn), [readColumn]);
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(() => setHeight(element.clientHeight));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (follow && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
      setTop(viewport.current.scrollTop);
    }
  }, [records, follow, compact, columnPaths.length]);
  const levelCharacters = useMemo(
    () => records.reduce((width, record) => Math.max(width, record.level.length), 4),
    [records],
  );
  const rowHeight = compact ? 20 : 34;
  const headerHeight = columnPaths.length ? 28 : 0;
  const centeredAnchor = useRef<typeof contextAnchor>();
  useLayoutEffect(() => {
    if (!contextAnchor || centeredAnchor.current === contextAnchor || !viewport.current) return;
    centeredAnchor.current = contextAnchor;
    const index = records.findIndex((record) => record.key === contextAnchor.key);
    if (index < 0) return;
    viewport.current.scrollTop = Math.max(
      0,
      index * rowHeight - (viewport.current.clientHeight - headerHeight - rowHeight) / 2,
    );
    setTop(viewport.current.scrollTop);
  }, [contextAnchor, records, rowHeight, headerHeight]);
  const fieldWidths = sizeColumns(records, columnPaths, viewport.current?.clientWidth ?? 0, compact);
  const start = Math.max(0, Math.floor(Math.max(0, top - headerHeight) / rowHeight) - 5);
  const visible = records.slice(start, start + Math.ceil(height / rowHeight) + 10);
  return (
    <div className="power-logs-viewer">
      <div
        className="power-logs-stream"
        ref={viewport}
        style={
          {
            "--power-log-level-ch": levelCharacters,
            "--power-log-extra-columns": columnPaths.length,
            "--power-log-field-columns": fieldWidths.length
              ? fieldWidths.map((width) => `${width}cqw`).join(" ")
              : undefined,
            "--power-log-fields-width": `${fieldWidths.reduce((total, width) => total + width, 0)}cqw`,
          } as CSSProperties
        }
        aria-label="Log lines"
        aria-busy={loading}
        onScroll={(event) => {
          const el = event.currentTarget;
          setTop(el.scrollTop);
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) setFollow(false);
        }}
      >
        {columnPaths.length > 0 && (
          <div className="power-log-column-headings" aria-label="Displayed log columns">
            <span>Time</span>
            <span>Level</span>
            <span className="power-log-origin">Source</span>
            <span>Message</span>
            {columnPaths.map((path, index) => (
              <NativeTooltip key={JSON.stringify(path)} title={logColumnLabel(path)}>
                <button
                  className="power-log-column-heading"
                  type="button"
                  aria-label={`Remove column ${logColumnLabel(path)}`}
                  onClick={() => onToggleColumn(path)}
                >
                  <span>{columnNames[index]}</span>
                  <Icon material="close" size={14} />
                </button>
              </NativeTooltip>
            ))}
          </div>
        )}
        {records.length === 0 ? (
          <div className="power-logs-empty">
            {loading ? (
              <span className="power-logs-loading" role="status">
                <Icon material="autorenew" size={20} />
                Loading logs…
              </span>
            ) : (
              "No matching log lines"
            )}
          </div>
        ) : (
          <div className="power-log-rows" style={{ height: records.length * rowHeight, position: "relative" }}>
            {visible.map((record, i) => (
              <div
                className="power-log-row"
                data-level={record.level}
                data-search-match={matches?.has(record) || undefined}
                data-context={(matches && !matches.has(record)) || undefined}
                style={{ top: (start + i) * rowHeight, height: rowHeight }}
                key={record.key}
              >
                <button
                  type="button"
                  className="power-log-open"
                  aria-pressed={selected === record.key}
                  onClick={() => onSelect(record)}
                >
                  <NativeTooltip
                    title={record.timestamp !== null ? formatDateTime(record.timestamp) : "Timestamp unavailable"}
                  >
                    <span>{record.timestamp !== null ? formatDateTime(record.timestamp).slice(-8) : "—"}</span>
                  </NativeTooltip>
                  <span className="power-log-level">{record.level}</span>
                  <span className="power-log-origin" id={`power-log-source-${record.key}`}>
                    {record.pod}
                    {record.previous ? " (previous)" : ""}
                    <Renderer.Component.Tooltip targetId={`power-log-source-${record.key}`}>
                      {sourceKey(record)}
                    </Renderer.Component.Tooltip>
                  </span>
                  <LogMessage text={record.message} />
                  {columnPaths.map((path) => {
                    const value = readColumn(record, path);
                    return (
                      <NativeTooltip key={JSON.stringify(path)} title={value}>
                        <span className="power-log-column-value">{value}</span>
                      </NativeTooltip>
                    );
                  })}
                </button>
                <NativeTooltip
                  title={
                    expanded.has(record.key)
                      ? "Hide surrounding lines"
                      : "Show up to 5 loaded lines before and after this line from the same source"
                  }
                >
                  <button
                    type="button"
                    className="power-log-context"
                    aria-label={expanded.has(record.key) ? "Hide surrounding lines" : "Show surrounding lines"}
                    aria-expanded={expanded.has(record.key)}
                    onClick={() => onToggleContext(record)}
                  >
                    <Icon material={expanded.has(record.key) ? "unfold_less" : "unfold_more"} size={16} />
                  </button>
                </NativeTooltip>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LogDetails({
  record,
  namespace,
  jsonColumn,
  onClose,
  onFilter,
  onToggleColumn,
  columnPaths,
}: {
  record: LogRecord;
  namespace?: string;
  jsonColumn?: string;
  onClose: () => void;
  onFilter?: (filter: JsonFieldFilter) => void;
  onToggleColumn?: (path: JsonPath) => void;
  columnPaths?: readonly JsonPath[];
}) {
  const structuredFields = useMemo(() => {
    if (!record?.fieldsJson) return "";
    return formatJsonLiteral(record.fieldsJson);
  }, [record?.fieldsJson]);
  const fieldsEnabled = useMemo(() => !jsonHasDuplicateKeys(record.fieldsJson ?? ""), [record.fieldsJson]);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [fieldCopyFeedback, setFieldCopyFeedback] = useState<{ kind: string; text: string }>();
  useEffect(() => setCopyFeedback(""), [structuredFields]);
  useEffect(() => setFieldCopyFeedback(undefined), [record.pod, namespace, record.level]);
  const formattedTime = record.timestamp === null ? "Unavailable" : formatDateTime(record.timestamp);
  const [date, time] = formattedTime.split("  ");
  const metadata = [
    { kind: "pod", label: "Pod:", value: record.pod, copyLabel: "Copy pod name", failure: "Unable to copy pod name" },
    {
      kind: "namespace",
      label: "Namespace:",
      value: namespace,
      copyLabel: "Copy namespace",
      failure: "Unable to copy namespace",
    },
    {
      kind: "level",
      label: "Level:",
      value: record.level.toUpperCase(),
      copyLabel: "Copy log level",
      failure: "Unable to copy log level",
    },
  ];
  return (
    <aside className="power-logs-detail" aria-label="Log line details">
      <header>
        <strong>Line details</strong>
        <NativeTooltip title="Close line details">
          <button className="power-logs-detail-close" aria-label="Close line details" onClick={onClose}>
            <Icon material="close" size={16} />
          </button>
        </NativeTooltip>
      </header>
      <div className="power-logs-detail-metadata">
        {metadata.map((field) => (
          <div key={field.kind} className={`power-logs-detail-field power-logs-detail-${field.kind}`}>
            <strong>{field.label}</strong>
            <span
              className={field.kind === "level" ? "power-logs-level-label" : undefined}
              data-level={field.kind === "level" ? record.level : undefined}
              title={field.kind === "pod" && record.container ? `Container: ${record.container}` : undefined}
            >
              {field.value || "Unavailable"}
            </span>
            {field.value && (
              <NativeTooltip title={fieldCopyFeedback?.kind === field.kind ? fieldCopyFeedback.text : field.copyLabel}>
                <button
                  type="button"
                  className="power-logs-detail-field-copy"
                  aria-label={field.copyLabel}
                  onClick={() => {
                    try {
                      clipboard.writeText(field.value!);
                      setFieldCopyFeedback({ kind: field.kind, text: "Copied" });
                    } catch {
                      setFieldCopyFeedback({ kind: field.kind, text: field.failure });
                    }
                  }}
                >
                  <Icon
                    material={
                      fieldCopyFeedback?.kind === field.kind && fieldCopyFeedback.text === "Copied"
                        ? "check"
                        : "content_copy"
                    }
                    size={14}
                  />
                </button>
              </NativeTooltip>
            )}
          </div>
        ))}
        <div className="power-logs-detail-time">
          <strong>Time:</strong>
          <span className="power-logs-detail-timestamp" aria-label={formattedTime}>
            <span>{date}</span>
            {time && (
              <>
                {"  "}
                <span>{time}</span>
              </>
            )}
          </span>
        </div>
      </div>
      {record.message && (
        <>
          <hr className="power-logs-detail-separator" />
          <pre>
            <LogMessage text={record.message} />
          </pre>
          <hr className="power-logs-detail-separator" />
        </>
      )}
      {record.fieldsJson && (
        <>
          <div className="power-logs-structured-heading">
            <strong>{jsonColumn ? `Structured fields · ${jsonColumn}` : "Structured fields"}</strong>
            <NativeTooltip title={copyFeedback || "Copy structured JSON"}>
              <button
                type="button"
                className="power-logs-detail-copy"
                aria-label="Copy structured JSON"
                onClick={() => {
                  try {
                    clipboard.writeText(structuredFields);
                    setCopyFeedback("Copied");
                  } catch {
                    setCopyFeedback("Unable to copy JSON");
                  }
                }}
              >
                <Icon material={copyFeedback === "Copied" ? "check" : "content_copy"} size={16} />
              </button>
            </NativeTooltip>
            <span className="power-logs-sr-only" aria-live="polite">
              {copyFeedback}
            </span>
          </div>
          <LogJson
            text={structuredFields}
            fieldsEnabled={fieldsEnabled}
            Icon={Icon}
            onFilter={onFilter}
            onToggleColumn={onToggleColumn}
            columnPaths={columnPaths}
          />
        </>
      )}
    </aside>
  );
}

const sameFieldValue = (a: JsonFieldFilter, b: JsonFieldFilter) =>
  a.path.length === b.path.length &&
  a.path.every((part, index) => part === b.path[index]) &&
  jsonValuesEqual(a.value, b.value);
const fieldFilterLabel = (filter: JsonFieldFilter) =>
  `${filter.path.reduce<string>((path, part) => `${path}[${typeof part === "number" ? part : JSON.stringify(part)}]`, "$")} ${filter.operator === "eq" ? "=" : "!="} ${JSON.stringify(filter.value)}`;
function FieldFilters({
  filters,
  sql = false,
  disabled = false,
  onRemove,
}: {
  filters: readonly (JsonFieldFilter & { column?: string })[];
  sql?: boolean;
  disabled?: boolean;
  onRemove(index: number): void;
}) {
  if (!filters.length) return null;
  return (
    <div className="power-logs-field-filters" aria-label={sql ? "SQL JSON filters" : "Live JSON filters"}>
      <span className="power-logs-muted">{sql ? "Result filters" : "JSON filters"} · AND</span>
      {filters.map((filter, index) => {
        const label = `${filter.column ? `${filter.column} ` : ""}${fieldFilterLabel(filter)}`;
        return (
          <NativeTooltip key={index} title={label}>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove JSON filter ${label}`}
              onClick={() => onRemove(index)}
            >
              <span>{label}</span>
              <Icon material="close" size={14} />
            </button>
          </NativeTooltip>
        );
      })}
    </div>
  );
}

function Workspace({ clusterId, contextId }: { clusterId: string; contextId: string }) {
  const client = useMemo(() => createPowerLogsClient({ clusterId, contextId }), [clusterId, contextId]);
  const drafts = useMemo(
    () =>
      new CaptureSqlDrafts(
        (id, query) => client.saveSql(id, query),
        (_id, error) =>
          setError(
            storageFull(error)
              ? POWER_LOGS_STORAGE_FULL
              : "Could not save the SQL draft. Your edits remain available in this workspace.",
          ),
      ),
    [client],
  );
  useEffect(
    () => () => {
      void drafts.dispose();
    },
    [drafts],
  );
  const [target, setTarget] = useState(initialTarget);
  const [records, setRecords] = useState<ViewRecord[]>([]);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [status, setStatus] = useState("Choose a resource to read its logs");
  const [error, setError] = useState("");
  const [sqlError, setSqlError] = useState("");
  const [tab, setTab] = useState<"live" | "captures">("live");
  const [text, setText] = useState("");
  const [contextKeys, setContextKeys] = useState<ReadonlySet<number>>(() => new Set());
  const [contextAnchor, setContextAnchor] = useState<{ key: number }>();
  const [level, setLevel] = useState("");
  const [source, setSource] = useState(initialSource);
  const [savedPoolFull, setSavedPoolFull] = useState(false);
  const [fieldFilters, setFieldFilters] = useState<JsonFieldFilter[]>([]);
  const [columnPaths, setColumnPaths] = useState<JsonPath[]>([]);
  const toggleColumn = (path: JsonPath) => {
    setColumnPaths((current) => {
      const identity = JSON.stringify(path);
      const exists = current.some((item) => JSON.stringify(item) === identity);
      if (exists) return current.filter((item) => JSON.stringify(item) !== identity);
      return current.length < 8 ? [...current, [...path]] : current;
    });
  };
  const matchFields = useMemo(() => compileJsonFilters(fieldFilters), [fieldFilters]);
  useEffect(() => {
    setContextKeys((keys) => (keys.size ? new Set() : keys));
    setContextAnchor(undefined);
  }, [text, level, source, fieldFilters, target?.uid]);
  const parsedFields = useRef(new WeakMap<LogRecord, unknown>());
  const [sqlFieldFilters, setSqlFieldFilters] = useState<{
    base: string;
    rendered: string;
    captureId: string;
    filters: SqlJsonFieldFilter[];
  }>();
  const preferences = LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>();
  const limits = normalizePowerLogsLimits(preferences.limits);
  useEffect(() => {
    applyPowerLogsLimits(preferences.limits);
  }, [preferences.limits]);
  const [compact, setCompact] = useState(preferences.compactRows === true);
  const [hideResourceName, setHideResourceName] = useState(preferences.hideResourceNameColumn === true);
  const [selected, setSelected] = useState<ViewRecord>();
  const [selectedSqlRow, setSelectedSqlRow] = useState<
    ReturnType<typeof sqlRowDetails> & { row: LogQueryResult["rows"][number] }
  >();
  const [liveCoverage, setLiveCoverage] = useState<LiveLogCoverage>();
  const [live, setLive] = useState(false);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(() => Boolean(initialTarget()));
  const [captures, setCaptures] = useState<LogCapture[]>([]);
  const [captureId, updateCaptureId] = useState("");
  const captureSelection = useRef(captureId);
  captureSelection.current = captureId;
  const setCaptureId = (id: string, snapshot = captures.find((item) => item.id === id)) => {
    if (id !== captureSelection.current) void drafts.flush();
    captureSelection.current = id;
    const query = snapshot ? drafts.read(snapshot, examples[0][1]) : examples[0][1];
    sqlDraft.current = query;
    updateSql(query);
    updateCaptureId(id);
  };
  const deleting = useRef(new Set<string>());
  const [deletingCount, setDeletingCount] = useState(0);
  const [capturing, setCapturing] = useState<LogCapture>();
  const [capturePending, setCapturePending] = useState(false);
  const [captureMinutes, setCaptureMinutes] = useState(15);
  const [previous, setPrevious] = useState(false);
  const [sqlFitVersion, setSqlFitVersion] = useState(0);
  const [sql, updateSql] = useState<string>(examples[0][1]);
  const sqlDraft = useRef(sql);
  sqlDraft.current = sql;
  const setSql = (query: string) => {
    sqlDraft.current = query;
    updateSql(query);
    if (captureSelection.current) drafts.set(captureSelection.current, query);
  };
  const captureKeys = useRef(new Map<string, string[]>());
  useEffect(() => {
    setSqlFieldFilters((current) =>
      current && (current.rendered !== sql || current.captureId !== captureId) ? undefined : current,
    );
  }, [sql, captureId]);
  const [result, setResult] = useState<LogQueryResult>();
  const [resultEvidence, setResultEvidence] = useState<{ capture: LogCapture; sql: string; error?: string }>();
  const [resultPage, setResultPage] = useState(0);
  const [queryId, setQueryId] = useState("");
  const captureOptions = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !captureOptions.current?.contains(event.target as Node) &&
        !(event.target as Element)?.closest?.(".Select__menu")
      ) {
        if (captureOptions.current) captureOptions.current.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target as Element)?.closest?.(".Select")) return;
      if (captureOptions.current?.open) captureOptions.current.open = false;
      else {
        setSelected(undefined);
        setSelectedSqlRow(undefined);
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const historyController = useRef<AbortController>();
  const liveController = useRef<AbortController>();
  const captureController = useRef<AbortController>();
  const queryRef = useRef("");
  const epoch = useRef(0);
  const alive = useRef(true);
  const sequence = useRef(0);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const pending = useRef<LogRecord[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout>>();
  const refreshCaptures = () =>
    client
      .list()
      .then((value) => {
        if (alive.current) setCaptures(value);
      })
      .catch(() => {
        if (alive.current) setError("Temporary captures are unavailable");
      });
  const stopLive = () => {
    liveController.current?.abort();
    liveController.current = undefined;
    setLive(false);
  };
  const flush = () => {
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    const batch = pending.current;
    pending.current = [];
    if (!batch.length || !alive.current) return;
    const next = batch.map((record) => ({
      ...record,
      key: ++sequence.current,
      bytes: Buffer.byteLength(JSON.stringify(record)),
    }));
    setRecords((current) => {
      const combined = [...current, ...next];
      let bytes = combined.reduce((sum, r) => sum + r.bytes, 0);
      let start = 0;
      while (combined.length - start > L.liveRows || bytes > L.liveBytes) bytes -= combined[start++].bytes;
      return combined.slice(start).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.key - b.key);
    });
  };
  const appendView = (batch: LogRecord[]) => {
    if (!alive.current) return;
    pending.current.push(...batch);
    if (pending.current.length > 1000) flush();
    else flushTimer.current ??= setTimeout(flush, 80);
  };
  useEffect(() => {
    alive.current = true;
    const onTarget = (event: Event) => {
      const next = parsePowerLogsTarget((event as CustomEvent).detail);
      if (next) {
        if (queryRef.current) {
          void client.cancel(queryRef.current).catch(() => {});
          queryRef.current = "";
          setQueryId("");
        }
        setSource(initialSource((event as CustomEvent).detail.container));
        setTarget(next);
      }
    };
    window.addEventListener("power-logs-target", onTarget);
    void refreshCaptures();
    const timer = setInterval(() => void refreshCaptures(), 30000);
    return () => {
      alive.current = false;
      epoch.current++;
      clearInterval(timer);
      clearTimeout(flushTimer.current);
      historyController.current?.abort();
      liveController.current?.abort();
      captureController.current?.abort();
      if (queryRef.current) void client.cancel(queryRef.current).catch(() => {});
      window.removeEventListener("power-logs-target", onTarget);
    };
  }, [client]);
  const readHistory = async () => {
    if (!target) return;
    const currentEpoch = ++epoch.current;
    historyController.current?.abort();
    stopLive();
    const controller = new AbortController();
    historyController.current = controller;
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    pending.current = [];
    setBusy(true);
    setRecords([]);
    setContextKeys(new Set());
    setContextAnchor(undefined);
    setSelected(undefined);
    setError("");
    setNotes([]);
    setStatus("Discovering owned containers…");
    try {
      const transport = createPowerLogsTransport(clusterId);
      const discovery = await resolveLogSources(target, transport, controller.signal);
      if (controller.signal.aborted || currentEpoch !== epoch.current) return;
      setSources(discovery.sources);
      setNotes(discovery.notes);
      setStatus(`Reading ${discovery.sources.length} container sources…`);
      const history = await collectHistoricalLogs(discovery.sources, transport, {
        signal: controller.signal,
        tailLines: L.historyLines,
        limitBytes: L.historyBytes,
        onRecords: (batch) => {
          if (currentEpoch === epoch.current) appendView(batch);
        },
      });
      if (controller.signal.aborted || currentEpoch !== epoch.current) return;
      flush();
      setNotes([...new Set([...discovery.notes, ...history.notes])]);
      setStatus(
        `${discovery.sources.length} sources · last ${limits.historyLines.toLocaleString()} lines per container, up to ${limits.historyBytes / 1048576} MiB each`,
      );
    } catch {
      if (alive.current && currentEpoch === epoch.current)
        setError(
          controller.signal.aborted
            ? "Log loading stopped"
            : "Could not read this resource's logs. Check permissions and whether it still exists.",
        );
    } finally {
      if (alive.current && currentEpoch === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    setText("");
    setFieldFilters([]);
    setSources([]);
    setTab("live");
    void readHistory();
  }, [target?.uid]);
  const toggleLive = () => {
    if (live) {
      stopLive();
      return;
    }
    setLive(true);
  };
  const sourceIdentity = sources.map((item) => `${item.podUid}/${item.container}`).join(";");
  useEffect(() => {
    if (!live || !sources.length) return;
    const controller = new AbortController();
    liveController.current = controller;
    const collector = startLiveLogs(sources, createPowerLogsTransport(clusterId), {
      signal: controller.signal,
      tailLines: L.historyLines,
      initialRecords: recordsRef.current,
      onRecords: appendView,
      onCoverage: (coverage) => {
        if (alive.current && liveController.current === controller)
          setLiveCoverage({ ...coverage, notes: [...coverage.notes] });
      },
    });
    setLiveCoverage({ ...collector.coverage });
    void collector.done.finally(() => {
      if (alive.current && !controller.signal.aborted && liveController.current === controller) {
        liveController.current = undefined;
        setLive(false);
      }
    });
    return () => {
      controller.abort();
      if (liveController.current === controller) liveController.current = undefined;
    };
  }, [live, sourceIdentity]);
  useEffect(() => {
    if (!live || !target) return;
    const controller = new AbortController();
    const startingEpoch = epoch.current;
    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void resolveLogSources(target, createPowerLogsTransport(clusterId), controller.signal)
        .then((discovery) => {
          if (controller.signal.aborted || epoch.current !== startingEpoch) return;
          setSources(discovery.sources);
          setNotes(discovery.notes);
          setStatus(`${discovery.sources.length} sources · ownership inventory refreshed`);
        })
        .catch(() => {
          if (!controller.signal.aborted && alive.current && epoch.current === startingEpoch) {
            stopLive();
            setNotes((current) => [
              ...new Set([
                ...current,
                "Workload inventory changed or became unavailable. Refresh before following logs again.",
              ]),
            ]);
          }
        })
        .finally(() => {
          refreshing = false;
        });
    }, 30000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [live, target?.uid]);
  const capture = async () => {
    if (!target || captureController.current || queryRef.current) return;
    setCapturePending(true);
    const controller = new AbortController();
    captureController.current = controller;
    let current: LogCapture | undefined;
    let partial = false;
    let storageLimitReached = false;
    let captureNotes: string[] = [];
    setError("");
    stopLive();
    try {
      current = await client.create(target);
      setCapturing(current);
      const transport = createPowerLogsTransport(clusterId);
      const discovery = await resolveLogSources(target, transport, controller.signal);
      captureNotes = discovery.notes;
      partial = discovery.partial;
      const captureSources = previous
        ? [...discovery.sources, ...discovery.sources.map((item) => ({ ...item, previous: true }))]
        : discovery.sources;
      const boundary = current.createdAt;
      const history = await collectHistoricalLogs(captureSources, transport, {
        signal: controller.signal,
        tailLines: L.captureSourceLines,
        sinceTime: new Date(boundary - captureMinutes * 60000).toISOString(),
        limitBytes: L.captureSourceBytes,
        onRecords: async (batch) => {
          if (batch.some((record) => record.timestamp === null)) {
            partial = true;
            captureNotes.push("Some records have no timestamp and their capture window cannot be verified");
          }
          batch = batch.filter(
            (record) =>
              record.timestamp === null ||
              (record.timestamp <= boundary && record.timestamp >= boundary - captureMinutes * 60000),
          );
          for (let offset = 0; offset < batch.length; ) {
            const chunk: LogRecord[] = [];
            let bytes = 2;
            while (offset < batch.length && chunk.length < L.batchRows) {
              const record = batch[offset];
              const size = Buffer.byteLength(JSON.stringify(record)) + 1;
              if (chunk.length && bytes + size > L.batchBytes) break;
              chunk.push(record);
              bytes += size;
              offset++;
            }
            if (controller.signal.aborted) throw new Error("Capture stopped");
            try {
              current = await client.append(current!.id, chunk);
              if (alive.current) setCapturing(current);
            } catch (error) {
              storageLimitReached ||= storageFull(error);
              controller.abort();
              if (storageFull(error)) throw error;
              throw new Error("Capture reached its storage limit or became unavailable");
            }
          }
        },
      });
      partial ||= history.partial;
      captureNotes.push(...history.notes);
    } catch (error) {
      storageLimitReached ||= storageFull(error);
      partial = true;
      captureNotes.push("Collection stopped or a source was unavailable; this snapshot may be incomplete");
    } finally {
      if (current) {
        try {
          const saved = await client.finish(
            current.id,
            partial || controller.signal.aborted,
            [...new Set(captureNotes)].slice(0, 20),
          );
          if (alive.current) {
            setCaptureId(saved.id, saved);
            setCaptures((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
            setTab("captures");
            setSql(examples[0][1]);
            void applyPreset("Recent", saved, true);
          }
        } catch (error) {
          storageLimitReached ||= storageFull(error);
          if (alive.current) {
            setCaptures((items) => [current!, ...items.filter((item) => item.id !== current!.id)]);
            setTab("captures");
            setError("The temporary capture could not be finalized");
          }
        }
      } else if (alive.current)
        setError("Could not create a capture. Delete an old snapshot or check the log service.");
      if (alive.current) {
        if (storageLimitReached) setError(POWER_LOGS_STORAGE_FULL);
        setCapturing(undefined);
        setCapturePending(false);
        void refreshCaptures();
      }
      captureController.current = undefined;
    }
  };
  const runQuery = async (selectedCapture?: LogCapture, query = sql) => {
    if (queryRef.current || (!selectedCapture && captureController.current)) return;
    const captured = selectedCapture ?? captures.find((item) => item.id === captureId);
    if (!captured || captured.state === "collecting" || deleting.current.has(captured.id)) return;
    const id = randomUUID();
    queryRef.current = id;
    setQueryId(id);
    setError("");
    setResult(undefined);
    setSelectedSqlRow(undefined);
    setSqlError("");
    setResultEvidence({ capture: captured, sql: query });
    setResultPage(0);
    try {
      const value = await client.query(captured.id, id, query);
      if (alive.current && queryRef.current === id) {
        if (value.error) {
          setSqlError(value.error);
          setResultEvidence({ capture: captured, sql: query, error: value.error });
        } else setResult(value);
      }
    } catch {
      if (alive.current && queryRef.current === id) {
        const message =
          "Query stopped or failed. Use one read-only SELECT or EXPLAIN; external files, networking and extensions are disabled.";
        setSqlError(message);
        setResultEvidence({ capture: captured, sql: query, error: message });
      }
    } finally {
      if (queryRef.current === id) {
        if (alive.current) setQueryId("");
        queryRef.current = "";
      }
    }
  };
  const applyPreset = async (title: "Recent" | "JSON", selectedCapture?: LogCapture, execute = false) => {
    const captured = selectedCapture ?? captures.find((item) => item.id === captureId);
    if (queryRef.current || (!selectedCapture && captureController.current)) return;
    if (title === "Recent") {
      const query = examples[0][1];
      setSql(query);
      setSqlFitVersion((version) => version + 1);
      setSelectedSqlRow(undefined);
      if (execute && captured) void runQuery(captured, query);
      return;
    }
    if (
      queryRef.current ||
      (!selectedCapture && captureController.current) ||
      !captured ||
      captured.state === "collecting" ||
      deleting.current.has(captured.id)
    )
      return;
    const draft = execute ? examples[0][1] : sqlDraft.current;
    const id = randomUUID();
    queryRef.current = id;
    setQueryId(id);
    setSqlError("");
    let prepared: string | undefined;
    try {
      let keys = captureKeys.current.get(captured.id);
      if (!keys) {
        const schema = await client.query(captured.id, id, JSON_KEY_DISCOVERY_SQL);
        if (schema.error) throw new Error(schema.error);
        const keyColumn = schema.columns.indexOf("key");
        keys = schema.truncated
          ? ["\0"]
          : keyColumn < 0
            ? []
            : schema.rows.map((row) => row[keyColumn]).filter((key): key is string => typeof key === "string");
        captureKeys.current.set(captured.id, keys);
        if (captureKeys.current.size > 10) captureKeys.current.delete(captureKeys.current.keys().next().value!);
      }
      if (!alive.current || queryRef.current !== id || captureSelection.current !== captured.id) return;
      if (sqlDraft.current !== draft) {
        setSqlError("SQL draft changed while detecting JSON fields. Select the preset again to replace it.");
        return;
      }
      prepared = buildJsonProjectionSql(keys);
      setSql(prepared);
      setSqlFitVersion((version) => version + 1);
      setSelectedSqlRow(undefined);
    } catch {
      if (alive.current) setSqlError("Could not detect JSON fields for this snapshot. Try the preset again.");
    } finally {
      if (queryRef.current === id) {
        queryRef.current = "";
        if (alive.current) setQueryId("");
      }
    }
    if (prepared && execute && alive.current) void runQuery(captured, prepared);
  };
  const addLiveFilter = (filter: JsonFieldFilter) => {
    if (!jsonValuesEqual(filter.value, filter.value)) {
      setError("This JSON value is too large or unsupported for filtering");
      return;
    }
    const existing = fieldFilters.findIndex((current) => sameFieldValue(current, filter));
    if (existing >= 0) {
      if (fieldFilters[existing].operator !== filter.operator) {
        setFieldFilters(fieldFilters.map((current, index) => (index === existing ? filter : current)));
      }
      return;
    }
    if (fieldFilters.length >= 32) {
      setError("Up to 32 JSON filters can be combined");
      return;
    }
    setFieldFilters([...fieldFilters, filter]);
  };
  const activeSqlFilters =
    sqlFieldFilters?.rendered === sql && sqlFieldFilters.captureId === captureId ? sqlFieldFilters : undefined;
  const sqlFilteringDisabled = Boolean(
    queryId ||
      capturePending ||
      deleting.current.has(captureId) ||
      !captures.some((capture) => capture.id === captureId && capture.state !== "collecting"),
  );
  const applySqlFilters = (filters: SqlJsonFieldFilter[]) => {
    if (queryRef.current || captureController.current || sqlFilteringDisabled) return;
    if (!resultEvidence || resultEvidence.sql !== sql) {
      setSqlError("Run the edited SQL query before filtering its results");
      return;
    }
    try {
      const base = activeSqlFilters?.base ?? sql;
      const query = buildJsonFilterSql(base, filters);
      setSqlFieldFilters({ base, rendered: query, captureId, filters });
      setSql(query);
      void runQuery(undefined, query);
    } catch {
      setSqlError("This JSON filter cannot be added to the query. Check the field path and value size.");
    }
  };
  const addSqlFilter = (column: string, filter: JsonFieldFilter) => {
    const columnNames = result?.columns.map((name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())) ?? [];
    if (!result?.columns.includes(column) || new Set(columnNames).size !== columnNames.length) {
      setSqlError("JSON filters require unique result column names, ignoring case");
      return;
    }
    const filters = activeSqlFilters?.filters ?? [];
    const existing = filters.findIndex((current) => current.column === column && sameFieldValue(current, filter));
    if (existing >= 0) {
      if (filters[existing].operator !== filter.operator) {
        applySqlFilters(filters.map((current, index) => (index === existing ? { ...filter, column } : current)));
      }
      return;
    }
    if (filters.length >= 32) {
      setSqlError("Up to 32 JSON filters can be combined");
      return;
    }
    applySqlFilters([...filters, { ...filter, column }]);
  };
  const matchesRecordFields = (record: LogRecord) => {
    if (!fieldFilters.length) return true;
    if (!parsedFields.current.has(record)) {
      let fields: unknown;
      try {
        fields = JSON.parse(record.fieldsJson ?? "null");
      } catch {
        fields = undefined;
      }
      parsedFields.current.set(record, fields);
    }
    return matchFields(parsedFields.current.get(record));
  };
  const filtered = useMemo(
    () =>
      records.filter(
        (record) =>
          (!text || record.message.toLocaleLowerCase().includes(text.toLocaleLowerCase())) &&
          (!level || record.level === level) &&
          (!source ||
            (source.startsWith("container:") ? record.container === source.slice(10) : sourceKey(record) === source)) &&
          matchesRecordFields(record),
      ),
    [records, text, level, source, fieldFilters, matchFields],
  );
  const chosenCapture = captures.find((item) => item.id === captureId);
  const matchingRecords = useMemo(() => new Set(filtered), [filtered]);
  const displayedRecords = useMemo(() => {
    if (!contextKeys.size) return filtered;
    const anchors = new Set(records.filter((record) => contextKeys.has(record.key)));
    const context = new Set(withLogContext(records, anchors, 5));
    return records.filter((record) => matchingRecords.has(record) || context.has(record));
  }, [records, matchingRecords, contextKeys, filtered]);
  const showContext = contextKeys.size > 0;
  const toggleContext = (record: ViewRecord) => {
    setFollow(false);
    setContextKeys((keys) => {
      const next = new Set(keys);
      if (next.has(record.key)) next.delete(record.key);
      else next.add(record.key);
      return next;
    });
    setContextAnchor({ key: record.key });
  };
  const collectionNotes = tab === "live" ? [...new Set([...notes, ...(live ? (liveCoverage?.notes ?? []) : [])])] : [];
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("power-logs-workspace-change", { detail: { active: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent("power-logs-workspace-change", { detail: { active: false } }));
    };
  }, []);
  useEffect(() => {
    const insert = (event: Event) => {
      const sql = (event as CustomEvent<{ sql?: unknown }>).detail?.sql;
      if (typeof sql !== "string" || !sql.trim() || sql.length > 65536) return;
      setTab("captures");
      setSelectedSqlRow(undefined);
      if (!captureId) {
        const latest = captures.find((item) => item.state !== "collecting" && item.target.uid === target?.uid);
        if (latest) setCaptureId(latest.id);
      }
      setSql(sql);
      requestAnimationFrame(() => document.getElementById("power-logs-sql")?.focus());
    };
    window.addEventListener("power-logs-sql-draft", insert);
    return () => window.removeEventListener("power-logs-sql-draft", insert);
  }, [captureId, captures, target?.uid]);
  const attachAi = () => {
    const queryEvidence =
      result ??
      (resultEvidence?.error
        ? {
            columns: [],
            rows: [],
            truncated: false,
            elapsedMs: 0,
            error: resultEvidence.error,
          }
        : undefined);
    const resource =
      tab === "captures"
        ? queryEvidence && resultEvidence
          ? resultEvidence.capture.target
          : (chosenCapture?.target ?? target)
        : target;
    const summary =
      tab === "captures" && queryEvidence && resultEvidence
        ? powerLogQueryEvidence(
            resultEvidence.capture,
            resultEvidence.sql,
            selectedSqlRow ? { ...queryEvidence, rows: [selectedSqlRow.row], truncated: false } : queryEvidence,
          )
        : tab === "live" && selected
          ? powerLogLineEvidence(resource, selected)
          : JSON.stringify({
              target: resource,
              ...(tab === "captures"
                ? { sql, rows: [], state: "Draft query, not executed" }
                : { status, sources: sources.length }),
            });
    if (
      !explainDiagnosticFinding({
        clusterId,
        source: "logs",
        title: tab === "captures" ? (selectedSqlRow ? "SQL row" : "SQL query") : selected ? "Log line" : "Power Logs",
        summary: summary.slice(0, 6000),
        ...(resource ? { resource: { kind: resource.kind, name: resource.name, namespace: resource.namespace } } : {}),
      })
    )
      window.dispatchEvent(new Event("power-ai-open-only"));
  };
  const deleteCapture = async (id: string) => {
    if (deleting.current.has(id) || queryRef.current || captureController.current) return;
    deleting.current.add(id);
    setDeletingCount(deleting.current.size);
    try {
      await drafts.flush();
      await client.delete(id);
      drafts.forget(id);
      if (id === captureSelection.current) {
        setCaptureId("");
        setResult(undefined);
        setResultEvidence(undefined);
        setSelectedSqlRow(undefined);
      }
      await refreshCaptures();
    } catch {
      setError("Could not delete capture");
    } finally {
      deleting.current.delete(id);
      if (alive.current) setDeletingCount(deleting.current.size);
    }
  };
  const confirmDeleteCapture = (id: string) => {
    const capture = captures.find((capture) => capture.id === id);
    if (!capture) return;
    Renderer.Component.ConfirmDialog.open({
      message: (
        <div className="power-logs-confirmation">
          Delete snapshot <strong>{capture.target.name}</strong>? This cannot be undone.
        </div>
      ),
      labelOk: (
        <span className="power-logs-confirm-label">
          <span aria-hidden="true">
            <Renderer.Component.Icon material="delete_outline" size={16} />
          </span>
          Delete snapshot
        </span>
      ),
      okButtonProps: { className: "ok power-logs-confirm-delete" },
      ok: () => deleteCapture(id),
    });
  };
  const confirmPersistentCapture = (capture: LogCapture) => {
    const persistent = !capture.persistent;
    Renderer.Component.ConfirmDialog.open({
      message: persistent ? (
        <div className="power-logs-confirmation">
          Keep snapshot <strong>{capture.target.name}</strong> until you delete it? It will survive restarts and will
          not expire automatically.
        </div>
      ) : (
        <div className="power-logs-confirmation">
          Allow snapshot <strong>{capture.target.name}</strong> to expire? Its retention period will start again now.
        </div>
      ),
      labelOk: (
        <span className="power-logs-confirm-label">
          <span aria-hidden="true">
            <Renderer.Component.Icon svg={persistent ? "push_pin" : "push_off"} size={16} />
          </span>
          {persistent ? "Keep snapshot" : "Allow expiration"}
        </span>
      ),
      ok: async () => {
        if (!alive.current || deleting.current.has(capture.id) || queryRef.current || captureController.current) return;
        deleting.current.add(capture.id);
        setDeletingCount(deleting.current.size);
        try {
          await drafts.flush();
          await client.setPersistent(capture.id, persistent);
          await refreshCaptures();
        } catch (error) {
          if (alive.current) {
            const full = error instanceof Error && error.message.includes("Saved snapshot limit reached");
            setSavedPoolFull(full);
            setError(
              full
                ? "Saved snapshot limit reached. Delete a saved snapshot or clear saved snapshots from all clusters."
                : storageFull(error)
                  ? POWER_LOGS_STORAGE_FULL
                  : "Could not update snapshot retention",
            );
          }
        } finally {
          deleting.current.delete(capture.id);
          if (alive.current) setDeletingCount(deleting.current.size);
        }
      },
    });
  };
  const clearSavedSnapshots = () =>
    Renderer.Component.ConfirmDialog.open({
      message: (
        <div className="power-logs-confirmation">
          Delete all saved snapshots from all clusters? Temporary snapshots will be kept. This cannot be undone.
        </div>
      ),
      labelOk: (
        <span className="power-logs-confirm-label">
          <span aria-hidden="true">
            <Renderer.Component.Icon material="delete_outline" size={16} />
          </span>
          Clear saved snapshots
        </span>
      ),
      okButtonProps: { className: "ok power-logs-confirm-delete" },
      ok: async () => {
        if (queryRef.current || captureController.current || deleting.current.size) return;
        deleting.current.add("clear-saved");
        setDeletingCount(deleting.current.size);
        try {
          await drafts.flush();
          await client.clearPersistent();
          const removed = captures.filter((capture) => capture.persistent);
          for (const capture of removed) drafts.forget(capture.id);
          if (removed.some((capture) => capture.id === captureSelection.current)) {
            setCaptureId("");
            setResult(undefined);
            setResultEvidence(undefined);
            setSelectedSqlRow(undefined);
          }
          setSavedPoolFull(false);
          setError("");
          await refreshCaptures();
        } catch {
          if (alive.current) setError("Could not clear saved snapshots");
        } finally {
          deleting.current.delete("clear-saved");
          if (alive.current) setDeletingCount(deleting.current.size);
        }
      },
    });
  const native = () => {
    const first = sources[0];
    const pod = Renderer.K8sApi.podsStore
      .getItems()
      .find((item) =>
        target?.kind === "Pod" ? item.metadata.uid === target.uid : item.metadata.uid === first?.podUid,
      );
    const requested = source.startsWith("container:")
      ? source.slice(10)
      : sources.find((item) => sourceKey(item) === source)?.container;
    const defaultContainer = pod?.metadata.annotations?.["kubectl.kubernetes.io/default-container"];
    const container =
      pod?.getAllContainers().find((item) => item.name === (requested ?? defaultContainer)) ??
      pod?.getAllContainers()[0];
    if (pod && container)
      Renderer.Component.logTabStore.createPodTab({ selectedPod: pod, selectedContainer: container });
    else setError("Open the Pod in the native resource view to use its Logs action");
  };
  const errorNotice = error && (
    <div role="alert" className="power-logs-notice power-logs-error">
      {error}
      {savedPoolFull && (
        <button type="button" disabled={deletingCount > 0 || !!queryId || capturePending} onClick={clearSavedSnapshots}>
          Clear saved snapshots
        </button>
      )}
    </div>
  );
  return (
    <div
      className="power-logs"
      data-testid="power-logs-page"
      data-compact={compact || undefined}
      data-hide-resource-name={hideResourceName || undefined}
    >
      <style>{powerLogsStyles}</style>
      <header>
        <h1 className="power-logs-page-title">Power Logs</h1>
        <div
          className="power-logs-tabs"
          role="tablist"
          aria-label="Log workspace"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
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
          <button role="tab" aria-selected={tab === "live"} onClick={() => setTab("live")}>
            <Icon material="subject" size={16} /> Live view
          </button>
          <button
            role="tab"
            aria-selected={tab === "captures"}
            onClick={() => {
              setTab("captures");
              const latest = captures.find(
                (item) => item.state !== "collecting" && (!target || item.target.uid === target.uid),
              );
              if (!captureId && latest && !capturePending) {
                setCaptureId(latest.id);
              }
              void refreshCaptures();
            }}
          >
            <Icon material="code" size={16} /> SQL
          </button>
        </div>

        <div className="power-logs-actions">
          <div className="power-logs-toolbar power-logs-capture">
            <details ref={captureOptions} className="power-logs-options">
              <NativeTooltip title={`Capture window: ${captureMinutes} minutes`}>
                <summary>
                  <Icon material="tune" size={16} /> Options
                </summary>
              </NativeTooltip>
              <div>
                {" "}
                <label>
                  Capture window
                  <LogSelect
                    label="Capture window"
                    value={String(captureMinutes)}
                    onChange={(value) => setCaptureMinutes(Number(value))}
                    options={[
                      { value: "5", label: "5 minutes" },
                      { value: "15", label: "15 minutes" },
                      { value: "60", label: "1 hour" },
                    ]}
                  />
                </label>
                <Renderer.Component.Switch checked={previous} onChange={setPrevious}>
                  Include previous containers
                </Renderer.Component.Switch>
                <Renderer.Component.Switch
                  checked={compact}
                  onChange={(value) => {
                    setCompact(value);
                    preferences.compactRows = value;
                  }}
                >
                  Compact density
                </Renderer.Component.Switch>
                <Renderer.Component.Switch
                  checked={hideResourceName}
                  onChange={(value) => {
                    setHideResourceName(value);
                    preferences.hideResourceNameColumn = value;
                  }}
                >
                  Hide resource name column
                </Renderer.Component.Switch>
              </div>
            </details>
            {tab === "captures" && (
              <button
                type="button"
                disabled={!target || capturePending || busy || !!queryId || deletingCount > 0}
                onClick={() => void capture()}
              >
                <Icon material="save_alt" size={16} /> Capture logs
              </button>
            )}
            {capturePending && (
              <>
                <span role="status" className="power-logs-muted">
                  {capturing
                    ? `${capturing.rows.toLocaleString()} lines · ${(capturing.bytes / 1048576).toFixed(1)} MiB`
                    : "Preparing capture…"}
                </span>
                <button type="button" onClick={() => captureController.current?.abort()}>
                  <Icon material="stop" size={16} /> Stop & keep partial
                </button>
              </>
            )}
          </div>

          <DiagnosticExplainButton aria-label="Open AI assistant" title="Open AI assistant" onClick={attachAi}>
            <Icon material="chat_bubble_outline" size={16} /> AI
          </DiagnosticExplainButton>
          {tab === "live" && (
            <button type="button" disabled={!target || busy} onClick={() => void readHistory()}>
              <Icon material="refresh" size={16} /> Refresh
            </button>
          )}
          {target?.kind === "Pod" && (
            <NativeTooltip title="Native logs">
              <button type="button" aria-label="Native logs" onClick={native}>
                <Renderer.Component.Icon material="open_in_new" size={16} />
              </button>
            </NativeTooltip>
          )}
        </div>
      </header>
      {target ? (
        <NativeTooltip title={`${target.kind} / ${target.name} · ${target.namespace} · UID ${target.uid}`}>
          <div className="power-logs-target power-logs-muted">
            <strong>
              {target.kind} / {target.name}
            </strong>{" "}
            · {target.namespace}
          </div>
        </NativeTooltip>
      ) : (
        <SourcePicker />
      )}
      {tab === "live" ? (
        <>
          <div className="power-logs-filters">
            <input
              aria-label="Search log messages"
              placeholder="Search messages…"
              value={text}
              maxLength={300}
              onChange={(event) => setText(event.target.value)}
            />
            <LogSelect
              label="Log level"
              value={level}
              onChange={setLevel}
              options={[
                { value: "", label: "All levels" },
                ...levels.map((value) => ({ value, label: value.toUpperCase() })),
              ]}
            />
            <LogSelect
              label="Container source"
              renderOption={(option, context) => {
                if (context !== "menu")
                  return (
                    <NativeTooltip title={option.label}>
                      <span>{option.label}</span>
                    </NativeTooltip>
                  );
                const item = sources.find((item) => sourceKey(item) === option.value);
                return (
                  <NativeTooltip title={option.label}>
                    <span className="power-logs-source-option">
                      <Icon material={item ? "view_in_ar" : "layers"} size={16} />
                      <span className="power-logs-option-text">
                        <strong>{item ? item.pod : option.value ? "All pods" : option.label}</strong>
                        <small>
                          {option.value
                            ? `Container · ${item?.container ?? option.value.slice(10)}`
                            : "Every pod and container"}
                          {item?.previous ? " · Previous" : ""}
                        </small>
                      </span>
                      <span className="power-logs-source-check" aria-hidden="true">
                        {source === option.value && <Icon material="check" size={16} />}
                      </span>
                    </span>
                  </NativeTooltip>
                );
              }}
              value={source}
              onChange={setSource}
              options={[
                { value: "", label: `All sources (${sources.length})` },
                ...[...new Set(sources.map((item) => item.container))].map((container) => ({
                  value: `container:${container}`,
                  label: `All pods / ${container}`,
                })),
                ...[...new Set(sources.map(sourceKey))].map((value) => ({ value, label: value })),
              ]}
            />
            <button
              type="button"
              disabled={!sources.length || busy || capturePending}
              aria-pressed={live}
              onClick={toggleLive}
            >
              <Icon material={live ? "pause" : "play_arrow"} size={16} /> {live ? "Pause" : "Live"}
            </button>
            <button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)}>
              <Icon material="vertical_align_bottom" size={16} /> Follow tail
            </button>
            {busy && (
              <button onClick={() => historyController.current?.abort()} type="button">
                <Icon material="stop" size={16} /> Stop loading
              </button>
            )}
          </div>
          {errorNotice}
          <FieldFilters
            filters={fieldFilters}
            onRemove={(index) => setFieldFilters(fieldFilters.filter((_, item) => item !== index))}
          />
          <NativeTooltip
            title={`${status} · Viewer retains up to ${limits.liveRows.toLocaleString()} lines / ${limits.liveBytes / 1048576} MiB`}
          >
            <div className="power-logs-muted power-logs-status" role="status">
              <span>{filtered.length.toLocaleString()} matching lines</span>
              {showContext && (
                <span>
                  {" "}
                  · {(displayedRecords.length - filtered.length).toLocaleString()} context lines (loaded only)
                </span>
              )}{" "}
              · {status}
              {liveCoverage && live ? ` · ${liveCoverage.active}/${liveCoverage.total} active sources` : ""} · Viewer
              retains up to {limits.liveRows.toLocaleString()} lines / {limits.liveBytes / 1048576} MiB
            </div>
          </NativeTooltip>
          <div className="power-logs-workspace">
            <LogRows
              records={displayedRecords}
              matches={showContext ? matchingRecords : undefined}
              expanded={contextKeys}
              onToggleContext={toggleContext}
              contextAnchor={contextAnchor}
              loading={busy}
              selected={selected?.key}
              onSelect={setSelected}
              follow={follow}
              setFollow={setFollow}
              compact={compact}
              columnPaths={columnPaths}
              onToggleColumn={toggleColumn}
            />
            {selected && (
              <LogDetails
                record={selected}
                namespace={target?.namespace}
                onClose={() => setSelected(undefined)}
                onFilter={addLiveFilter}
                onToggleColumn={toggleColumn}
                columnPaths={columnPaths}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="power-logs-toolbar power-logs-snapshot-bar">
            <span className="power-logs-control-label">Snapshot</span>
            <LogSelect
              label="Capture snapshot"
              onKeyDown={(event) => {
                if (
                  event.key !== "Delete" ||
                  !event.altKey ||
                  ((event.target as HTMLInputElement).value ?? "").length > 0
                )
                  return;
                const button = document.querySelector<HTMLButtonElement>(
                  ".Select__menu .Select__option--is-focused [data-capture-delete]",
                );
                if (button && !button.disabled) {
                  event.preventDefault();
                  event.stopPropagation();
                  confirmDeleteCapture(button.dataset.captureDelete!);
                }
              }}
              renderOption={(option, context) => {
                const item = captures.find((item) => item.id === option.value);
                if (context !== "menu" || !item) return option.label;
                return (
                  <span className="power-logs-snapshot-option">
                    <NativeTooltip title={option.label}>
                      <span className="power-logs-option-text">
                        <strong>{item.target.name}</strong>
                        <small>
                          {formatDateTime(item.createdAt)} · {item.rows.toLocaleString()} lines ·{" "}
                          {item.state[0].toUpperCase()}
                          {item.state.slice(1)}
                          {item.persistent ? " · Persistent" : ""}
                        </small>
                      </span>
                    </NativeTooltip>
                    <NativeTooltip title={item.persistent ? "Allow snapshot to expire" : "Keep snapshot"}>
                      <button
                        type="button"
                        aria-label={`${item.persistent ? "Allow expiration for" : "Keep"} snapshot ${item.target.name}`}
                        aria-pressed={Boolean(item.persistent)}
                        data-capture-persistent={item.id}
                        onKeyDown={(event) => event.stopPropagation()}
                        disabled={!!queryId || capturePending || deletingCount > 0 || item.state === "collecting"}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          confirmPersistentCapture(item);
                        }}
                      >
                        <Renderer.Component.Icon svg={item.persistent ? "push_off" : "push_pin"} size={16} />
                      </button>
                    </NativeTooltip>
                    <NativeTooltip title="Delete snapshot (Alt+Delete)">
                      <button
                        type="button"
                        aria-label={`Delete snapshot ${item.target.name}`}
                        data-capture-delete={item.id}
                        onKeyDown={(event) => event.stopPropagation()}
                        disabled={!!queryId || capturePending || deletingCount > 0}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          confirmDeleteCapture(item.id);
                        }}
                      >
                        <Renderer.Component.Icon material="delete_outline" size={16} />
                      </button>
                    </NativeTooltip>
                  </span>
                );
              }}
              value={captureId}
              disabled={!!queryId || capturePending || deletingCount > 0}
              onChange={(value) => {
                setCaptureId(value);
                setResult(undefined);
                setResultEvidence(undefined);
                setSelectedSqlRow(undefined);
                setSqlError("");
              }}
              options={[
                { value: "", label: "Choose a snapshot" },
                ...captures.map((item) => ({
                  value: item.id,
                  label: `${item.target.name} · ${formatDateTime(item.createdAt)} · ${item.rows.toLocaleString()} lines · ${item.state[0].toUpperCase()}${item.state.slice(1)}${item.persistent ? " · Persistent" : ""}`,
                })),
              ]}
            />
            <NativeTooltip title="Export JSON Lines (NDJSON)">
              <button
                type="button"
                disabled={!captureId || !!queryId || deleting.current.has(captureId)}
                onClick={() => {
                  void client.export(captureId).catch(() => setError("Could not export capture"));
                }}
              >
                <Icon material="download" size={16} /> Export JSON
              </button>
            </NativeTooltip>
          </div>
          <div className="power-logs-toolbar power-logs-sql-tools">
            <NativeTooltip
              title={`Read-only SELECT · ${limits.queryMs / 1000} s · ${limits.resultRows.toLocaleString()} rows · Schema: logs(timestamp INTEGER in milliseconds, pod, podUid, container, level, message, fieldsJson, previous INTEGER 0 or 1)`}
            >
              <label htmlFor="power-logs-sql" className="power-logs-control-label">
                SQL query
              </label>
            </NativeTooltip>
            <button
              type="button"
              disabled={
                !chosenCapture ||
                !!queryId ||
                capturePending ||
                deleting.current.has(captureId) ||
                chosenCapture.state === "collecting"
              }
              onClick={() => void runQuery()}
            >
              <Icon material="play_arrow" size={16} /> Run query
            </button>
            {queryId && (
              <button
                type="button"
                onClick={() => {
                  void client.cancel(queryId).catch(() => setError("Could not cancel query"));
                }}
              >
                <Icon material="stop" size={16} /> Cancel
              </button>
            )}
            {examples.map(([title, query]) => (
              <button
                type="button"
                key={title}
                disabled={!!queryId || capturePending}
                onClick={() => {
                  if (title === "JSON" || title === "Recent") void applyPreset(title);
                  else {
                    setSql(query);
                    setSqlFitVersion((version) => version + 1);
                  }
                }}
              >
                <Icon
                  material={
                    title === "Recent"
                      ? "history"
                      : title === "Errors"
                        ? "error_outline"
                        : title === "Timeline"
                          ? "timeline"
                          : "data_object"
                  }
                  size={16}
                />{" "}
                SQL · {title}
              </button>
            ))}
          </div>
          <FieldFilters
            sql
            filters={activeSqlFilters?.filters ?? []}
            disabled={sqlFilteringDisabled}
            onRemove={(index) => applySqlFilters((activeSqlFilters?.filters ?? []).filter((_, item) => item !== index))}
          />
          <SqlEditor id="power-logs-sql" value={sql} onChange={setSql} fitVersion={sqlFitVersion} />
          {errorNotice}
          {sqlError && (
            <div role="alert" className="power-logs-notice power-logs-error power-logs-query-error">
              {sqlError}
            </div>
          )}
          {result ? (
            <>
              <div className="power-logs-toolbar power-logs-results-bar">
                <span role="status" className="power-logs-muted">
                  {result.rows.length} rows · {result.elapsedMs} ms{result.truncated ? " · Result truncated" : ""}
                </span>
              </div>
              <div className="power-logs-workspace">
                <div className="power-logs-results">
                  <table
                    style={{
                      minWidth:
                        result.columns.length > 3
                          ? result.columns.reduce((width, column) => width + sqlColumnWidth(column), 0)
                          : undefined,
                    }}
                  >
                    <colgroup>
                      {result.columns.map((column, i) => (
                        <col
                          key={i}
                          style={{
                            width: result.columns.length > 3 ? sqlColumnWidth(column) : undefined,
                          }}
                        />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        {result.columns.map((column, i) => (
                          <th key={i} data-column={column}>
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(resultPage * 50, (resultPage + 1) * 50).map((row, i) => (
                        <tr
                          key={i}
                          tabIndex={0}
                          aria-label={`Open SQL row ${resultPage * 50 + i + 1}`}
                          onClick={() => setSelectedSqlRow({ ...sqlRowDetails(result.columns, row), row })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedSqlRow({ ...sqlRowDetails(result.columns, row), row });
                            }
                          }}
                        >
                          {row.map((cell, j) => (
                            <td
                              key={j}
                              data-column={result.columns[j]}
                              data-level={sqlCellLevel(result.columns[j], cell)}
                            >
                              <LogJsonCell
                                value={cell === null ? null : String(cell)}
                                column={result.columns[j]}
                                rawValue={cell}
                                Icon={Icon}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.rows.length === 0 && (
                    <div className="power-logs-empty">
                      {chosenCapture?.rows === 0
                        ? "This snapshot contains no log lines. Try a longer capture window."
                        : "This query returned no rows. Adjust the query or choose SQL · Recent."}
                    </div>
                  )}
                </div>
                {selectedSqlRow && (
                  <LogDetails
                    record={selectedSqlRow.record}
                    namespace={chosenCapture?.target.namespace}
                    jsonColumn={selectedSqlRow.jsonColumn}
                    onFilter={
                      !sqlFilteringDisabled && selectedSqlRow.jsonColumn
                        ? (filter) => addSqlFilter(selectedSqlRow.jsonColumn!, filter)
                        : undefined
                    }
                    onClose={() => setSelectedSqlRow(undefined)}
                  />
                )}
              </div>
              {result.rows.length > 50 && (
                <nav className="power-logs-toolbar power-logs-pagination" aria-label="SQL result pages">
                  <NativeTooltip title="Previous page">
                    <button
                      type="button"
                      aria-label="Previous page"
                      disabled={resultPage === 0}
                      onClick={() => {
                        setResultPage(resultPage - 1);
                        setSelectedSqlRow(undefined);
                      }}
                    >
                      <Icon material="chevron_left" size={16} />
                    </button>
                  </NativeTooltip>
                  <span className="power-logs-muted">
                    Page {resultPage + 1} / {Math.max(1, Math.ceil(result.rows.length / 50))}
                  </span>
                  <NativeTooltip title="Next page">
                    <button
                      type="button"
                      aria-label="Next page"
                      disabled={(resultPage + 1) * 50 >= result.rows.length}
                      onClick={() => {
                        setResultPage(resultPage + 1);
                        setSelectedSqlRow(undefined);
                      }}
                    >
                      <Icon material="chevron_right" size={16} />
                    </button>
                  </NativeTooltip>
                </nav>
              )}
            </>
          ) : (
            <div className="power-logs-results power-logs-empty">
              {queryId
                ? "Running query…"
                : captures.length === 0
                  ? "Capture logs to create a temporary snapshot for SQL."
                  : "Choose a snapshot to preview its logs."}
            </div>
          )}
        </>
      )}
      <div className="power-logs-muted power-logs-footer">
        <NativeTooltip
          title={`Gentle collection: ${limits.requestsPerSecond} requests/s, ${limits.bytesPerSecond / 1048576} MiB/s. Captures: ${limits.captureSourceLines.toLocaleString()} lines / ${limits.captureSourceBytes / 1048576} MiB per source, ${limits.captureBytes / 1048576} MiB total. Up to ${limits.captures} snapshots retained for ${limits.ttlMs / 60000} minutes.`}
        >
          <span className="power-logs-caption">
            Collection · {limits.requestsPerSecond} req/s · {limits.bytesPerSecond / 1048576} MiB/s ·{" "}
            {limits.captureBytes / 1048576} MiB/snapshot · Retention {limits.ttlMs / 60000} min
          </span>
        </NativeTooltip>
        {tab === "live" && collectionNotes.length > 0 && (
          <NativeTooltip title={collectionNotes.join("\n")}>
            <span role="note" className="power-logs-notice power-logs-collection-note">
              <Icon material="warning_amber" size={14} />
              <span>{collectionNotes.join(" · ")}</span>
            </span>
          </NativeTooltip>
        )}
        {tab === "captures" &&
          chosenCapture &&
          (chosenCapture.state === "partial" || chosenCapture.notes.length > 0) && (
            <NativeTooltip
              title={
                chosenCapture.notes.join("\n") ||
                "Collection stopped or a source was unavailable; this snapshot may be incomplete"
              }
            >
              <span role="note" className="power-logs-notice power-logs-collection-note">
                <Icon material="warning_amber" size={14} />
                <span>Incomplete snapshot</span>
              </span>
            </NativeTooltip>
          )}
      </div>
    </div>
  );
}

const ObservedWorkspace = observer(Workspace);

export const PowerLogsPage = observer(() => {
  const enabled = LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>().enabled;
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  if (!enabled || !clusterId)
    return (
      <div className="power-logs">
        <style>{powerLogsStyles}</style>
        <h1>Power Logs</h1>
        <p>Enable Power Logs in Power settings and open a cluster to view logs.</p>
      </div>
    );
  const contextId = searchContextId();
  return <ObservedWorkspace key={`${clusterId}:${contextId}`} clusterId={clusterId} contextId={contextId} />;
});
