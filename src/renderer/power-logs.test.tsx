// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PowerLogsPage } from "./power-logs";

import type { LogCapture, LogRecord, LogTarget } from "../common/power-logs";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  query: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
  resolve: vi.fn(),
  nativeWorkload: vi.fn(),
  nativePod: vi.fn(),
  explain: vi.fn(),
  delete: vi.fn(),
  export: vi.fn(),
  objects: [] as any[],
}));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.copy } }));
vi.mock("../common/store/logs-preferences-store", () => ({
  LogsPreferencesStore: { getInstanceOrCreate: () => ({ enabled: true }) },
}));
vi.mock("./power-logs-client", () => ({ createPowerLogsClient: () => mocks }));
vi.mock("./power-logs-transport", () => ({ createPowerLogsTransport: () => ({}) }));
vi.mock("./resource-search-client", () => ({ searchContextId: () => "context-a" }));
vi.mock("./ai-diagnostic-handoff", () => ({ explainDiagnosticFinding: mocks.explain }));
vi.mock("./diagnostic-explain-button", () => ({
  DiagnosticExplainButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("./power-logs-entrypoints", () => ({
  parsePowerLogsTarget: (value: any) => (value?.uid ? value : undefined),
  openPowerLogs: vi.fn(),
}));
vi.mock("./power-logs-collector", () => ({
  collectHistoricalLogs: (...args: any[]) => mocks.history(...args),
  resolveLogSources: (...args: any[]) => mocks.resolve(...args),
  startLiveLogs: () => ({ coverage: {}, done: new Promise(() => {}) }),
}));
vi.mock("@freelensapp/extensions", () => {
  const store = { getItems: () => mocks.objects };
  return {
    Renderer: {
      Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-a" } }) } },
      K8sApi: Object.fromEntries(
        [
          "podsStore",
          "deploymentStore",
          "daemonSetStore",
          "statefulSetStore",
          "replicaSetStore",
          "jobStore",
          "cronJobStore",
        ].map((key) => [key, store]),
      ),
      Component: {
        Icon: () => null,
        Select: ({ "aria-label": label, value, options, onChange, isDisabled, formatOptionLabel }: any) => {
          const [open, setOpen] = useState(false);
          return (
            <>
              <select
                aria-label={label}
                value={value}
                disabled={isDisabled}
                onClick={() => setOpen(!open)}
                onChange={(event) => onChange(options.find((option: any) => option.value === event.target.value))}
              >
                {options.map((option: any) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {open && label === "Capture snapshot" && (
                <div>
                  {options.map((option: any) => (
                    <div key={option.value}>{formatOptionLabel(option, { context: "menu" })}</div>
                  ))}
                </div>
              )}
            </>
          );
        },
        Switch: ({ checked, onChange, children }: any) => (
          <label>
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            {children}
          </label>
        ),
        logTabStore: { createWorkloadTab: mocks.nativeWorkload, createPodTab: mocks.nativePod },
      },
    },
  };
});
const target: LogTarget = { kind: "Deployment", namespace: "default", name: "application", uid: "workload-a" };
const snapshot: LogCapture = {
  id: "capture-a",
  target: { ...target, name: "captured-application", uid: "captured-a" },
  createdAt: 10000000,
  expiresAt: 13600000,
  state: "ready",
  rows: 10,
  bytes: 1000,
  notes: [],
};
const source = { namespace: "default", pod: "application-a", podUid: "pod-a", container: "application" };
const record = (index: number, overrides: Partial<LogRecord> = {}): LogRecord => ({
  timestamp: 9999000 + index,
  pod: source.pod,
  podUid: source.podUid,
  container: source.container,
  level: "info",
  message: `message ${index}`,
  fieldsJson: null,
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  const view = render(<PowerLogsPage />);
  await waitFor(() => expect(screen.queryByText("Stop loading")).toBeNull());
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", `/?target=${encodeURIComponent(JSON.stringify(target))}`);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.objects = [{ kind: target.kind, metadata: { ...target } }];
  mocks.list.mockResolvedValue([snapshot]);
  mocks.resolve.mockResolvedValue({
    sources: [source, { ...source, container: "sidecar" }],
    notes: [],
    partial: false,
  });
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([]);
    return { notes: [], partial: false };
  });
  mocks.create.mockResolvedValue(snapshot);
  mocks.append.mockResolvedValue(snapshot);
  mocks.finish.mockResolvedValue(snapshot);
  mocks.cancel.mockResolvedValue(true);
  mocks.query.mockResolvedValue({
    columns: ["message"],
    rows: [["captured log message"]],
    truncated: false,
    elapsedMs: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([false, true])("shows loading until discovery and history finish (has logs: %s)", async (hasLogs) => {
  const discovery = deferred<{ sources: (typeof source)[]; notes: string[]; partial: boolean }>();
  const history = deferred<{ notes: string[]; partial: boolean }>();
  mocks.resolve.mockReturnValue(discovery.promise);
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    const result = await history.promise;
    await options.onRecords(hasLogs ? [record(0)] : []);
    return result;
  });
  render(<PowerLogsPage />);
  expect(screen.getByText("Loading logs…")).toBeTruthy();
  expect(screen.queryByText("No matching log lines")).toBeNull();
  expect(screen.getByLabelText("Log lines").getAttribute("aria-busy")).toBe("true");
  await act(async () => discovery.resolve({ sources: [source], notes: [], partial: false }));
  expect(screen.getByText("Loading logs…")).toBeTruthy();
  expect(screen.queryByText("No matching log lines")).toBeNull();
  await act(async () => history.resolve({ notes: [], partial: false }));
  await waitFor(() => expect(screen.getByLabelText("Log lines").getAttribute("aria-busy")).toBe("false"));
  expect(screen.queryByText("Loading logs…")).toBeNull();
  if (hasLogs) {
    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.queryByText("No matching log lines")).toBeNull();
  } else expect(screen.getByText("No matching log lines")).toBeTruthy();
});

it.each([false, true])("copies complete structured JSON and reports clipboard failure (fails: %s)", async (fails) => {
  const json = { nested: { values: [1, "two", true] }, message: "full JSON" };
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0, { fieldsJson: JSON.stringify(json) })]);
    return { notes: [], partial: false };
  });
  if (fails)
    mocks.copy.mockImplementationOnce(() => {
      throw new Error("clipboard unavailable");
    });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-row")!);
  const copy = screen.getByRole("button", { name: "Copy structured JSON" });
  fireEvent.click(copy);
  expect(mocks.copy).toHaveBeenCalledWith(JSON.stringify(json, null, 2));
  expect(copy.getAttribute("title")).toBe(fails ? "Unable to copy JSON" : "Copied");
  if (fails) expect(screen.queryByText("Copied")).toBeNull();
});

it("virtualizes a large stream and filters and expands a specific source line", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords(
      Array.from({ length: 2000 }, (_, index) =>
        record(
          index,
          index === 1 ? { container: "sidecar", message: "needle failure", fieldsJson: '{"reason":"timeout"}' } : {},
        ),
      ),
    );
    return { notes: [], partial: false };
  });
  const view = await mount();
  expect(screen.getByText("2,000 matching lines")).toBeTruthy();
  expect(view.container.querySelectorAll(".power-log-row").length).toBeLessThan(30);
  expect((view.container.querySelector(".power-log-row") as HTMLElement).style.height).toBe("34px");
  fireEvent.click(screen.getByLabelText("Compact density"));
  expect((view.container.querySelector(".power-log-row") as HTMLElement).style.height).toBe("20px");
  fireEvent.click(screen.getByLabelText("Compact density"));
  expect((view.container.querySelector(".power-log-row") as HTMLElement).style.height).toBe("34px");
  fireEvent.change(screen.getByLabelText("Search log messages"), { target: { value: "needle" } });
  fireEvent.change(screen.getByLabelText("Container source"), { target: { value: "container:sidecar" } });
  expect(screen.getByText("1 matching lines")).toBeTruthy();
  fireEvent.click(view.container.querySelector(".power-log-row")!);
  expect(JSON.parse(screen.getByLabelText("Log line details").querySelector(".power-log-json")!.textContent!)).toEqual({
    reason: "timeout",
  });
  fireEvent.change(screen.getByLabelText("Container source"), { target: { value: "container:application" } });
  expect(screen.getByText("No matching log lines")).toBeTruthy();
});

it("hides native logs for workloads without a native view", async () => {
  await mount();
  expect(screen.queryByRole("button", { name: "Native logs" })).toBeNull();
  expect(mocks.nativeWorkload).not.toHaveBeenCalled();
  expect(mocks.nativePod).not.toHaveBeenCalled();
});

it("shows actionable SQL errors without presenting failed results as AI evidence", async () => {
  mocks.query.mockResolvedValue({
    columns: [],
    rows: [],
    truncated: false,
    elapsedMs: 1,
    error: "SQLite could not run this query. Check SQL syntax, column names and supported functions.",
  });
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByText("Run query"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Check SQL syntax, column names and supported functions"),
  );
  expect(view.container.querySelector(".power-logs-results table")).toBeNull();
  expect(screen.queryByRole("button", { name: "Review AI context" })).toBeNull();
});

it("reviews executed SQL and its capture identity with redacted values after editing SQL", async () => {
  const pending = deferred<any>();
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  await screen.findByText("captured log message");
  mocks.query.mockClear();
  mocks.query.mockReturnValue(pending.promise);
  fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: "SELECT token FROM logs" } });
  const run = screen.getByText("Run query");
  act(() => {
    fireEvent.click(run);
    fireEvent.click(run);
  });
  expect(mocks.query).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: "SELECT edited FROM logs" } });
  await act(async () => {
    pending.resolve({ columns: ["token"], rows: [["private-test-value"]], truncated: false, elapsedMs: 1 });
  });
  act(() => {
    window.dispatchEvent(
      new CustomEvent("power-logs-target", {
        detail: { ...target, name: "other-current-resource", uid: "other-workload" },
      }),
    );
  });
  await waitFor(() => expect(screen.queryByText("Stop loading")).toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByRole("button", { name: "Open AI assistant" }));
  const preview = mocks.explain.mock.calls[0][0].summary as string;
  expect(preview).toContain("SELECT token FROM logs");
  expect(preview).not.toContain("SELECT edited FROM logs");
  expect(preview).toContain("captured-application");
  expect(preview).not.toContain("other-current-resource");
  expect(preview).not.toContain("private-test-value");
  expect(preview).toContain("[REDACTED]");
  expect(mocks.explain.mock.calls[0][0].resource.name).toBe("captured-application");
});

it("keeps a newer snapshot selected when an earlier snapshot deletion resolves", async () => {
  const other = {
    ...snapshot,
    id: "capture-b",
    target: { ...snapshot.target, name: "other-capture", uid: "capture-b" },
  };
  mocks.list.mockResolvedValue([snapshot, other]);
  const deleting = deferred<boolean>();
  mocks.delete = vi.fn().mockReturnValue(deleting.promise);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  await screen.findByText("captured log message");
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  fireEvent.click(screen.getByRole("button", { name: `Delete snapshot ${snapshot.target.name}` }));
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Run query" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Export JSON" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: other.id } });
  await act(async () => {
    deleting.resolve(true);
  });
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).value).toBe(other.id);
});

it("attaches a bounded draft context after clearing an executed snapshot", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  await screen.findByText("captured log message");
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: 'SELECT "' + "x".repeat(65000) + '"' } });
  fireEvent.click(screen.getByRole("button", { name: "Open AI assistant" }));
  const finding = mocks.explain.mock.calls[0][0];
  expect(finding.resource.name).toBe(target.name);
  expect(finding.summary.length).toBeLessThanOrEqual(6000);
  expect(finding.summary).not.toContain(snapshot.target.name);
});

it("uses a fixed capture boundary and marks timestamp-less records partial while guarding rapid capture clicks", async () => {
  await mount();
  const pending = deferred<LogCapture>();
  mocks.create.mockReturnValue(pending.promise);
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    expect(options.sinceTime).toBe(new Date(snapshot.createdAt - 15 * 60000).toISOString());
    await options.onRecords([
      record(0, { timestamp: snapshot.createdAt - 1000 }),
      record(1, { timestamp: snapshot.createdAt + 1 }),
      record(2, { timestamp: snapshot.createdAt - 15 * 60000 - 1 }),
      record(3, { timestamp: null }),
    ]);
    return { notes: [], partial: false };
  });
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  const capture = screen.getByText("Capture logs");
  act(() => {
    fireEvent.click(capture);
    fireEvent.click(capture);
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(snapshot);
  });
  await waitFor(() => expect(mocks.finish).toHaveBeenCalled());
  expect(mocks.append.mock.calls[0][1].map((line: LogRecord) => line.timestamp)).toEqual([
    snapshot.createdAt - 1000,
    null,
  ]);
  expect(mocks.finish.mock.calls[0][1]).toBe(true);
  expect(mocks.finish.mock.calls[0][2].join(" ")).toContain("no timestamp");
});

it("keeps a canceled capture as a partial snapshot", async () => {
  await mount();
  mocks.history.mockImplementation(
    (_sources, _transport, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("stopped")));
      }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByText("Capture logs"));
  fireEvent.click(await screen.findByText("Stop & keep partial"));
  await waitFor(() =>
    expect(mocks.finish).toHaveBeenCalledWith(
      snapshot.id,
      true,
      expect.arrayContaining([expect.stringContaining("Collection stopped")]),
    ),
  );
});

it("previews recent logs automatically after selecting and finishing a capture", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  expect(await screen.findByText("captured log message")).toBeTruthy();
  expect(mocks.query.mock.calls[0][2]).toContain("SELECT message, level");
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByText("Capture logs"));
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("captured log message")).toBeTruthy();
});

it("opens SQL rows by pointer and keyboard, chooses the largest JSON and clears details on paging", async () => {
  mocks.query.mockResolvedValue({
    columns: ["message", "small", "payload"],
    rows: Array.from({ length: 51 }, () => ["query row", '{"a":1}', '{"reason":"timeout","nested":{"enabled":true}}']),
    elapsedMs: 1,
    truncated: false,
  });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  const row = await screen.findByLabelText("Open SQL row 1");
  fireEvent.click(row);
  const detail = screen.getByLabelText("Log line details");
  expect(within(detail).getByText("Structured fields · payload")).toBeTruthy();
  expect(JSON.parse(detail.querySelector(".power-log-json")!.textContent!)).toEqual({
    reason: "timeout",
    nested: { enabled: true },
  });
  fireEvent.click(within(detail).getByRole("button", { name: "Close line details" }));
  fireEvent.keyDown(row, { key: "Enter" });
  expect(screen.getByLabelText("Log line details")).toBeTruthy();
  const pagination = screen.getByRole("navigation", { name: "SQL result pages" });
  expect(pagination.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  fireEvent.click(within(pagination).getByRole("button", { name: "Next page" }));
  expect(screen.queryByLabelText("Log line details")).toBeNull();
  expect(screen.getByLabelText("Open SQL row 51")).toBeTruthy();
});

it("inserts AI SQL drafts without executing and keeps each toolbar scoped to its tab", async () => {
  await mount();
  expect(screen.queryByRole("button", { name: "Capture logs" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  act(() => {
    window.dispatchEvent(new CustomEvent("power-logs-sql-draft", { detail: { sql: "SELECT count(*) FROM logs" } }));
  });
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("SELECT count(*) FROM logs");
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.getByRole("button", { name: "Capture logs" })).toBeTruthy();
  expect(mocks.query).not.toHaveBeenCalled();
});

it("prevents capture collection while a SQL query is pending", async () => {
  const pending = deferred<any>();
  mocks.query.mockReturnValue(pending.promise);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  expect(mocks.query).toHaveBeenCalledTimes(1);
  const capture = screen.getByRole("button", { name: "Capture logs" }) as HTMLButtonElement;
  expect(capture.disabled).toBe(true);
  fireEvent.click(capture);
  expect(mocks.create).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ columns: ["message"], rows: [["query completed"]], truncated: false, elapsedMs: 1 });
  });
  expect(capture.disabled).toBe(false);
});

it("blocks snapshot queries during collection and previews the newly finished capture", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  await screen.findByText("captured log message");
  mocks.query.mockClear();
  const nextCapture: LogCapture = { ...snapshot, id: "capture-b", target, rows: 1 };
  const pending = deferred<{ notes: string[]; partial: boolean }>();
  mocks.create.mockResolvedValue({ ...nextCapture, state: "collecting" });
  mocks.finish.mockResolvedValue(nextCapture);
  mocks.list.mockResolvedValue([nextCapture, snapshot]);
  mocks.history.mockReturnValue(pending.promise);
  mocks.query.mockResolvedValue({
    columns: ["message"],
    rows: [["new snapshot message"]],
    truncated: false,
    elapsedMs: 1,
  });
  fireEvent.click(screen.getByRole("button", { name: "Capture logs" }));
  await screen.findByText("Stop & keep partial");
  const run = screen.getByRole("button", { name: "Run query" }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(run);
  expect(mocks.query).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ notes: [], partial: false });
  });
  expect(await screen.findByText("new snapshot message")).toBeTruthy();
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0][0]).toBe(nextCapture.id);
  expect(mocks.query.mock.calls[0][2]).toContain("SELECT message, level");
});

it("explains an empty successful SQL result", async () => {
  mocks.query.mockResolvedValue({ columns: ["message"], rows: [], truncated: false, elapsedMs: 1 });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  expect(await screen.findByText(/This query returned no rows/)).toBeTruthy();
  expect(screen.getByText(/0 rows/)).toBeTruthy();
});

it("locks snapshot controls immediately while capture creation is pending", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  await screen.findByText("captured log message");
  mocks.query.mockClear();
  mocks.history.mockClear();
  const pending = deferred<LogCapture>();
  const nextCapture: LogCapture = { ...snapshot, id: "capture-pending", target };
  mocks.create.mockReturnValue(pending.promise);
  mocks.finish.mockResolvedValue(nextCapture);
  mocks.list.mockResolvedValue([nextCapture, snapshot]);
  const capture = screen.getByRole("button", { name: "Capture logs" });
  act(() => {
    fireEvent.click(capture);
    fireEvent.click(capture);
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.history).not.toHaveBeenCalled();
  const run = screen.getByRole("button", { name: "Run query" }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(run);
  expect(mocks.query).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ ...nextCapture, state: "collecting" });
  });
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
  expect(mocks.query.mock.calls[0][0]).toBe(nextCapture.id);
  expect(await screen.findByText("captured log message")).toBeTruthy();
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).disabled).toBe(false);
});

it("navigates compact header tabs with arrow, Home and End keys", async () => {
  await mount();
  const live = screen.getByRole("tab", { name: "Live view", exact: true });
  const sql = screen.getByRole("tab", { name: "SQL", exact: true });
  const tabs = screen.getByRole("tablist", { name: "Log workspace" });
  expect(tabs.closest("header")).toBeTruthy();
  expect(sql.textContent?.trim()).toBe("SQL");
  expect(sql.querySelector('[aria-hidden="true"]')).toBeTruthy();
  expect(live.querySelector('[aria-hidden="true"]')).toBeTruthy();
  live.focus();
  const navigate = (key: string, next: HTMLElement, previous: HTMLElement) => {
    fireEvent.keyDown(document.activeElement!, { key });
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-selected")).toBe("true");
    expect(previous.getAttribute("aria-selected")).toBe("false");
  };
  navigate("ArrowRight", sql, live);
  navigate("ArrowRight", live, sql);
  navigate("ArrowLeft", sql, live);
  navigate("ArrowLeft", live, sql);
  navigate("End", sql, live);
  navigate("Home", live, sql);
});
