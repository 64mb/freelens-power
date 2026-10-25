import { randomUUID } from "node:crypto";
import { Renderer } from "@freelensapp/extensions";
import { clipboard } from "electron";
import { observer } from "mobx-react";
import {
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
  POWER_LOGS_LIMITS as L,
  type LogCapture,
  type LogLevel,
  type LogQueryResult,
  type LogRecord,
  type LogSource,
  type LogTarget,
} from "../common/power-logs";
import { powerLogLineEvidence, powerLogQueryEvidence } from "../common/power-logs-ai";
import { applyPowerLogsLimits, normalizePowerLogsLimits } from "../common/power-logs-limits";
import { LogsPreferencesStore } from "../common/store/logs-preferences-store";
import { explainDiagnosticFinding } from "./ai-diagnostic-handoff";
import { DiagnosticExplainButton } from "./diagnostic-explain-button";
import { LogJson } from "./power-log-json";
import { powerLogsStyles } from "./power-logs.css";
import { createPowerLogsClient } from "./power-logs-client";
import { collectHistoricalLogs, type LiveLogCoverage, resolveLogSources, startLiveLogs } from "./power-logs-collector";
import { openPowerLogs, parsePowerLogsTarget } from "./power-logs-entrypoints";
import { sqlRowDetails } from "./power-logs-sql-row";
import { createPowerLogsTransport } from "./power-logs-transport";
import { searchContextId } from "./resource-search-client";

const Icon = (props: { material: string; size?: number }) => (
  <span aria-hidden="true" style={{ display: "inline-flex" }}>
    <Renderer.Component.Icon {...props} />
  </span>
);
const sourceKey = (r: Pick<LogRecord, "pod" | "container" | "previous">) =>
  `${r.pod} / ${r.container}${r.previous ? " (previous)" : ""}`;
const levels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"];
const examples = [
  ["Recent", "SELECT message, level, container, pod, timestamp FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200"],
  [
    "Errors",
    "SELECT pod, container, count(*) AS errors FROM logs WHERE level IN ('error','fatal') GROUP BY pod, container ORDER BY errors DESC",
  ],
  [
    "Timeline",
    "SELECT strftime('%Y-%m-%d %H:%M', timestamp / 1000, 'unixepoch') AS minute, level, count(*) AS lines FROM logs GROUP BY minute, level ORDER BY minute",
  ],
  [
    "JSON",
    "SELECT pod, json_extract(fieldsJson, '$.message') AS message FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100",
  ],
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
  label,
  value,
  options,
  onChange,
  disabled = false,
  renderOption,
  onKeyDown,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  renderOption?: (option: { value: string; label: string }, context: "menu" | "value") => ReactNode;
}) {
  return (
    <span className="power-logs-select" data-source-select={label === "Container source" || undefined}>
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
  const stores = [
    Renderer.K8sApi.podsStore,
    Renderer.K8sApi.deploymentStore,
    Renderer.K8sApi.daemonSetStore,
    Renderer.K8sApi.statefulSetStore,
    Renderer.K8sApi.replicaSetStore,
    Renderer.K8sApi.jobStore,
    Renderer.K8sApi.cronJobStore,
  ];
  const targets = stores.flatMap((store) =>
    store.getItems().flatMap((object) => {
      const target = parsePowerLogsTarget({ kind: object.kind, ...object.metadata });
      return target ? [target] : [];
    }),
  );
  const [value, setValue] = useState("");
  const sorted = [...targets].sort((a, b) =>
    `${a.namespace}/${a.kind}/${a.name}`.localeCompare(`${b.namespace}/${b.kind}/${b.name}`),
  );
  return (
    <div className="power-logs-source">
      <span>Resource</span>
      <LogSelect
        label="Resource"
        value={value}
        onChange={setValue}
        options={[
          { value: "", label: "Choose a loaded pod or workload" },
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
}: {
  records: ViewRecord[];
  loading: boolean;
  selected?: number;
  onSelect(record: ViewRecord): void;
  follow: boolean;
  setFollow(value: boolean): void;
  compact: boolean;
}) {
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
  }, [records, follow, compact]);
  const rowHeight = compact ? 20 : 34;
  const start = Math.max(0, Math.floor(top / rowHeight) - 5);
  const visible = records.slice(start, start + Math.ceil(height / rowHeight) + 10);
  return (
    <div className="power-logs-viewer">
      <div
        className="power-logs-stream"
        ref={viewport}
        aria-label="Log lines"
        aria-busy={loading}
        onScroll={(event) => {
          const el = event.currentTarget;
          setTop(el.scrollTop);
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) setFollow(false);
        }}
      >
        {records.length === 0 ? (
          <div className="power-logs-empty">{loading ? "Loading logs…" : "No matching log lines"}</div>
        ) : (
          <div style={{ height: records.length * rowHeight, position: "relative" }}>
            {visible.map((record, i) => (
              <button
                type="button"
                className="power-log-row"
                data-level={record.level}
                aria-pressed={selected === record.key}
                style={{ top: (start + i) * rowHeight, height: rowHeight }}
                key={record.key}
                onClick={() => onSelect(record)}
              >
                <span title={record.timestamp !== null ? formatDateTime(record.timestamp) : "Timestamp unavailable"}>
                  {record.timestamp !== null ? formatDateTime(record.timestamp).slice(-8) : "—"}
                </span>
                <span className="power-log-level">{record.level}</span>
                <span className="power-log-origin" title={sourceKey(record)}>
                  {record.container}
                  {record.previous ? " (previous)" : ""} · {record.pod}
                </span>
                <span>{record.message}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LogDetails({ record, jsonColumn, onClose }: { record: LogRecord; jsonColumn?: string; onClose: () => void }) {
  const structuredFields = useMemo(() => {
    if (!record?.fieldsJson) return "";
    try {
      return JSON.stringify(JSON.parse(record.fieldsJson), null, 2);
    } catch {
      return record.fieldsJson;
    }
  }, [record?.fieldsJson]);
  const [copyFeedback, setCopyFeedback] = useState("");
  useEffect(() => setCopyFeedback(""), [structuredFields]);
  return (
    <aside className="power-logs-detail" aria-label="Log line details">
      <header>
        <strong>Line details</strong>
        <button
          className="power-logs-detail-close"
          aria-label="Close line details"
          title="Close line details"
          onClick={onClose}
        >
          <Icon material="close" size={16} />
        </button>
      </header>
      <p className="power-logs-muted">{[record.pod && sourceKey(record), record.level].filter(Boolean).join(" · ")}</p>
      {record.message && <pre>{record.message}</pre>}
      {record.fieldsJson && (
        <>
          <div className="power-logs-structured-heading">
            <strong>{jsonColumn ? `Structured fields · ${jsonColumn}` : "Structured fields"}</strong>
            <button
              type="button"
              className="power-logs-detail-copy"
              aria-label="Copy structured JSON"
              title={copyFeedback || "Copy structured JSON"}
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
            <span className="power-logs-muted" aria-live="polite">
              {copyFeedback}
            </span>
          </div>
          <LogJson text={structuredFields} />
        </>
      )}
    </aside>
  );
}

function Workspace({ clusterId, contextId }: { clusterId: string; contextId: string }) {
  const client = useMemo(() => createPowerLogsClient({ clusterId, contextId }), [clusterId, contextId]);
  const [target, setTarget] = useState(initialTarget);
  const [records, setRecords] = useState<ViewRecord[]>([]);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [status, setStatus] = useState("Choose a resource to read its logs");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"live" | "captures">("live");
  const [text, setText] = useState("");
  const [level, setLevel] = useState("");
  const [source, setSource] = useState(initialSource);
  const preferences = LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>();
  const limits = normalizePowerLogsLimits(preferences.limits);
  useEffect(() => {
    applyPowerLogsLimits(preferences.limits);
  }, [preferences.limits]);
  const [compact, setCompact] = useState(preferences.compactRows === true);
  const [selected, setSelected] = useState<ViewRecord>();
  const [selectedSqlRow, setSelectedSqlRow] = useState<
    ReturnType<typeof sqlRowDetails> & { row: LogQueryResult["rows"][number] }
  >();
  const [liveCoverage, setLiveCoverage] = useState<LiveLogCoverage>();
  const [live, setLive] = useState(false);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState(() => Boolean(initialTarget()));
  const [captures, setCaptures] = useState<LogCapture[]>([]);
  const [captureId, setCaptureId] = useState("");
  const captureSelection = useRef(captureId);
  captureSelection.current = captureId;
  const deleting = useRef(new Set<string>());
  const [deletingCount, setDeletingCount] = useState(0);
  const [capturing, setCapturing] = useState<LogCapture>();
  const [capturePending, setCapturePending] = useState(false);
  const [captureMinutes, setCaptureMinutes] = useState(15);
  const [previous, setPrevious] = useState(false);
  const [sql, setSql] = useState<string>(examples[0][1]);
  const [result, setResult] = useState<LogQueryResult>();
  const [resultEvidence, setResultEvidence] = useState<{ capture: LogCapture; sql: string }>();
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
            } catch {
              controller.abort();
              throw new Error("Capture reached its storage limit or became unavailable");
            }
          }
        },
      });
      partial ||= history.partial;
      captureNotes.push(...history.notes);
    } catch {
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
            setCaptureId(saved.id);
            setCaptures((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
            setTab("captures");
            setSql(examples[0][1]);
            void runQuery(saved, examples[0][1]);
          }
        } catch {
          if (alive.current) setError("The temporary capture could not be finalized");
        }
      } else if (alive.current)
        setError("Could not create a capture. Delete an old snapshot or check the log service.");
      if (alive.current) {
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
    setResultEvidence({ capture: captured, sql: query });
    setResultPage(0);
    try {
      const value = await client.query(captured.id, id, query);
      if (alive.current && queryRef.current === id) {
        if (value.error) setError(value.error);
        else setResult(value);
      }
    } catch {
      if (alive.current && queryRef.current === id)
        setError(
          "Query stopped or failed. Use one read-only SELECT or EXPLAIN; external files, networking and extensions are disabled.",
        );
    } finally {
      if (queryRef.current === id) {
        if (alive.current) setQueryId("");
        queryRef.current = "";
      }
    }
  };
  const filtered = useMemo(
    () =>
      records.filter(
        (record) =>
          (!text || record.message.toLocaleLowerCase().includes(text.toLocaleLowerCase())) &&
          (!level || record.level === level) &&
          (!source ||
            (source.startsWith("container:") ? record.container === source.slice(10) : sourceKey(record) === source)),
      ),
    [records, text, level, source],
  );
  const chosenCapture = captures.find((item) => item.id === captureId);
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
      setSql(sql);
      setSelectedSqlRow(undefined);
      if (!captureId) {
        const latest = captures.find((item) => item.state !== "collecting" && item.target.uid === target?.uid);
        if (latest) setCaptureId(latest.id);
      }
      requestAnimationFrame(() => document.getElementById("power-logs-sql")?.focus());
    };
    window.addEventListener("power-logs-sql-draft", insert);
    return () => window.removeEventListener("power-logs-sql-draft", insert);
  }, [captureId, captures, target?.uid]);
  const attachAi = () => {
    const resource =
      tab === "captures"
        ? result && resultEvidence
          ? resultEvidence.capture.target
          : (chosenCapture?.target ?? target)
        : target;
    const summary =
      tab === "captures" && result && resultEvidence
        ? powerLogQueryEvidence(
            resultEvidence.capture,
            resultEvidence.sql,
            selectedSqlRow ? { ...result, rows: [selectedSqlRow.row], truncated: false } : result,
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
      await client.delete(id);
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
  return (
    <div className="power-logs" data-testid="power-logs-page" data-compact={compact || undefined}>
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
                setSql(examples[0][1]);
                void runQuery(latest, examples[0][1]);
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
              <summary title={`Capture window: ${captureMinutes} minutes`}>
                <Icon material="tune" size={16} /> Options
              </summary>
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
            <button type="button" aria-label="Native logs" title="Native logs" onClick={native}>
              <Renderer.Component.Icon material="open_in_new" size={16} tooltip="Native logs" tooltipOverrideDisabled />
            </button>
          )}
        </div>
      </header>
      {target ? (
        <div
          className="power-logs-target power-logs-muted"
          title={`${target.kind} / ${target.name} · ${target.namespace} · UID ${target.uid}`}
        >
          <strong>
            {target.kind} / {target.name}
          </strong>{" "}
          · {target.namespace}
        </div>
      ) : (
        <SourcePicker />
      )}
      {error && (
        <div role="alert" className="power-logs-notice power-logs-error">
          {error}
        </div>
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
                if (context !== "menu") return <span title={option.label}>{option.label}</span>;
                const item = sources.find((item) => sourceKey(item) === option.value);
                return (
                  <span className="power-logs-source-option" title={option.label}>
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
          <div
            className="power-logs-muted power-logs-status"
            role="status"
            title={`${status} · Viewer retains up to ${limits.liveRows.toLocaleString()} lines / ${limits.liveBytes / 1048576} MiB`}
          >
            <span>{filtered.length.toLocaleString()} matching lines</span> · {status}
            {liveCoverage && live ? ` · ${liveCoverage.active}/${liveCoverage.total} active sources` : ""} · Viewer
            retains up to {limits.liveRows.toLocaleString()} lines / {limits.liveBytes / 1048576} MiB
          </div>
          <div className="power-logs-workspace">
            <LogRows
              records={filtered}
              loading={busy}
              selected={selected?.key}
              onSelect={setSelected}
              follow={follow}
              setFollow={setFollow}
              compact={compact}
            />
            {selected && <LogDetails record={selected} onClose={() => setSelected(undefined)} />}
          </div>
        </>
      ) : (
        <>
          <div className="power-logs-toolbar power-logs-snapshot-bar">
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
                  void deleteCapture(button.dataset.captureDelete!);
                }
              }}
              renderOption={(option, context) => {
                const item = captures.find((item) => item.id === option.value);
                if (context !== "menu" || !item) return option.label;
                return (
                  <span className="power-logs-snapshot-option" title={option.label}>
                    <span className="power-logs-option-text">
                      <strong>{item.target.name}</strong>
                      <small>
                        {formatDateTime(item.createdAt)} · {item.rows.toLocaleString()} lines ·{" "}
                        {item.state[0].toUpperCase()}
                        {item.state.slice(1)}
                      </small>
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete snapshot ${item.target.name}`}
                      title="Delete snapshot (Alt+Delete)"
                      data-capture-delete={item.id}
                      onKeyDown={(event) => event.stopPropagation()}
                      disabled={!!queryId || capturePending || deletingCount > 0 || item.state === "collecting"}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteCapture(item.id);
                      }}
                    >
                      <Renderer.Component.Icon
                        material="delete_outline"
                        size={16}
                        tooltip="Delete snapshot"
                        tooltipOverrideDisabled
                      />
                    </button>
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
                const snapshot = captures.find((item) => item.id === value);
                if (snapshot) {
                  setSql(examples[0][1]);
                  void runQuery(snapshot, examples[0][1]);
                }
              }}
              options={[
                { value: "", label: "Choose a snapshot" },
                ...captures.map((item) => ({
                  value: item.id,
                  label: `${item.target.name} · ${formatDateTime(item.createdAt)} · ${item.rows.toLocaleString()} lines · ${item.state[0].toUpperCase()}${item.state.slice(1)}`,
                })),
              ]}
            />
            <button
              type="button"
              disabled={!captureId || !!queryId || deleting.current.has(captureId)}
              title="Export JSON Lines (NDJSON)"
              onClick={() => {
                void client.export(captureId).catch(() => setError("Could not export capture"));
              }}
            >
              <Icon material="download" size={16} /> Export JSON
            </button>
          </div>
          {!!chosenCapture?.notes.length && (
            <details className="power-logs-snapshot-notes power-logs-muted">
              <summary>Snapshot notes ({chosenCapture.notes.length})</summary>
              {chosenCapture.notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
            </details>
          )}
          <div className="power-logs-toolbar power-logs-sql-tools">
            <label
              htmlFor="power-logs-sql"
              title={`Read-only SELECT · ${limits.queryMs / 1000} s · ${limits.resultRows.toLocaleString()} rows · Schema: logs(timestamp INTEGER in milliseconds, pod, podUid, container, level, message, fieldsJson, previous INTEGER 0 or 1)`}
            >
              SQL query
            </label>
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
              <button type="button" key={title} onClick={() => setSql(query)}>
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
                SQL: {title}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            id="power-logs-sql"
            value={sql}
            maxLength={65536}
            onChange={(event) => setSql(event.target.value)}
            spellCheck={false}
          />
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
                              data-level={result.columns[j] === "level" ? String(cell) : undefined}
                            >
                              <span className="power-logs-cell" title={cell === null ? "NULL" : String(cell)}>
                                {cell === null ? "NULL" : String(cell)}
                              </span>
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
                        : "This query returned no rows. Adjust the query or choose SQL: Recent."}
                    </div>
                  )}
                </div>
                {selectedSqlRow && (
                  <LogDetails
                    record={selectedSqlRow.record}
                    jsonColumn={selectedSqlRow.jsonColumn}
                    onClose={() => setSelectedSqlRow(undefined)}
                  />
                )}
              </div>
              {result.rows.length > 50 && (
                <nav className="power-logs-toolbar power-logs-pagination" aria-label="SQL result pages">
                  <button
                    type="button"
                    aria-label="Previous page"
                    title="Previous page"
                    disabled={resultPage === 0}
                    onClick={() => {
                      setResultPage(resultPage - 1);
                      setSelectedSqlRow(undefined);
                    }}
                  >
                    <Icon material="chevron_left" size={16} />
                  </button>
                  <span className="power-logs-muted">
                    Page {resultPage + 1} / {Math.max(1, Math.ceil(result.rows.length / 50))}
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    title="Next page"
                    disabled={(resultPage + 1) * 50 >= result.rows.length}
                    onClick={() => {
                      setResultPage(resultPage + 1);
                      setSelectedSqlRow(undefined);
                    }}
                  >
                    <Icon material="chevron_right" size={16} />
                  </button>
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
        <span
          className="power-logs-caption"
          title={`Gentle collection: ${limits.requestsPerSecond} requests/s, ${limits.bytesPerSecond / 1048576} MiB/s. Captures: ${limits.captureSourceLines.toLocaleString()} lines / ${limits.captureSourceBytes / 1048576} MiB per source, ${limits.captureBytes / 1048576} MiB total. Up to ${limits.captures} snapshots retained for ${limits.ttlMs / 60000} minutes.`}
        >
          Gentle collection · {limits.requestsPerSecond} requests/s · {limits.bytesPerSecond / 1048576} MiB/s · Captures
          limited to {limits.captureSourceLines.toLocaleString()} lines / {limits.captureSourceBytes / 1048576} MiB per
          source and {limits.captureBytes / 1048576} MiB total · Up to {limits.captures} temporary snapshots, retained
          for {limits.ttlMs / 60000} min
        </span>
        {collectionNotes.length > 0 && (
          <span role="note" className="power-logs-notice power-logs-collection-note" title={collectionNotes.join("\n")}>
            <Icon material="warning_amber" size={14} />
            <span>{collectionNotes.join(" · ")}</span>
          </span>
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
