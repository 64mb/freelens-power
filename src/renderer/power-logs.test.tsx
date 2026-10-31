// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatDateTime } from "../common/date-time";
import { JSON_KEY_DISCOVERY_SQL } from "../common/power-log-json-preset";
import {
  type LogCapture,
  type LogRecord,
  type LogTarget,
  POWER_LOGS_CHANNEL,
  POWER_LOGS_STORAGE_FULL,
} from "../common/power-logs";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";
import { PowerLogsPage } from "./power-logs";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  confirm: vi.fn(),
  setPersistent: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  saveSql: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  discover: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
  resolve: vi.fn(),
  nativeWorkload: vi.fn(),
  nativePod: vi.fn(),
  explain: vi.fn(),
  delete: vi.fn(),
  clearPersistent: vi.fn(),
  namespaceLoad: vi.fn(),
  export: vi.fn(),
  objects: [] as any[],
}));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.copy } }));
vi.mock("../common/store/logs-preferences-store", () => ({
  LogsPreferencesStore: { getInstanceOrCreate: () => ({ enabled: true }) },
}));
vi.mock("./power-logs-client", () => ({
  createPowerLogsClient: () => ({
    ...mocks,
    query: (...args: any[]) => (args[2] === JSON_KEY_DISCOVERY_SQL ? mocks.discover(...args) : mocks.query(...args)),
  }),
}));
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
  return {
    Renderer: {
      Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-a" } }) } },
      K8sApi: {
        namespaceStore: { onContextChange: () => () => {}, loadAll: (...args: any[]) => mocks.namespaceLoad(...args) },
        ...Object.fromEntries(
          [
            "podsStore",
            "deploymentStore",
            "daemonSetStore",
            "statefulSetStore",
            "replicaSetStore",
            "jobStore",
            "cronJobStore",
          ].map((key) => [
            key,
            {
              get contextItems() {
                return mocks.objects.filter(
                  (object) =>
                    object.kind.toLowerCase() === key.replace("Store", "").replace("pods", "pod").toLowerCase(),
                );
              },
              loadAll: async () => {},
              subscribe: () => () => {},
            },
          ]),
        ),
      },
      Component: {
        ConfirmDialog: { open: (...args: any[]) => mocks.confirm(...args) },
        Icon: ({ material, svg }: any) => <span aria-hidden="true" data-icon={material ?? svg} />,
        Tooltip: (props: any) => <MockTooltip {...props} />,
        NamespaceSelectFilter: ({ id }: { id: string }) => <input id={id} readOnly value="default" />,
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
  mocks.namespaceLoad.mockResolvedValue([]);
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
  mocks.confirm.mockImplementation((params) => params.ok());
  mocks.setPersistent.mockResolvedValue(snapshot);
  mocks.saveSql.mockResolvedValue(undefined);
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
  mocks.discover.mockResolvedValue({ columns: ["key"], rows: [], truncated: false, elapsedMs: 1 });
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

it("lists workloads before pods across namespaces when opened without a resource", async () => {
  window.history.replaceState({}, "", "/");
  mocks.objects = [
    { kind: "Pod", metadata: { namespace: "alpha", name: "worker", uid: "pod-a" } },
    ...["StatefulSet", "ReplicaSet", "Job", "Deployment", "DaemonSet", "CronJob"].map((kind) => ({
      kind,
      metadata: { namespace: "zeta", name: "worker", uid: kind },
    })),
    { kind: "Deployment", metadata: { namespace: "beta", name: "z-worker", uid: "deployment-z" } },
    { kind: "Deployment", metadata: { namespace: "beta", name: "a-worker", uid: "deployment-a" } },
  ];
  await mount();
  expect(screen.getByLabelText("Namespace")).toBeTruthy();
  expect(
    within(screen.getByLabelText("Resource"))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual([
    "Choose a pod or workload",
    "beta / Deployment / a-worker",
    "beta / Deployment / z-worker",
    "zeta / CronJob / worker",
    "zeta / DaemonSet / worker",
    "zeta / Deployment / worker",
    "zeta / Job / worker",
    "zeta / ReplicaSet / worker",
    "zeta / StatefulSet / worker",
    "alpha / Pod / worker",
  ]);
});

it("distinguishes resource loading failures from an empty selection and allows retry", async () => {
  window.history.replaceState({}, "", "/");
  mocks.objects = [];
  mocks.namespaceLoad.mockImplementationOnce(async (options) => {
    options.onLoadFailure(new Error("Unavailable"));
    return [];
  });
  await mount();
  await waitFor(() => expect(screen.getByText(/Could not load some resources/)).toBeTruthy());
  expect(screen.queryByText(/No pods or workloads found/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading resources" }));
  await waitFor(() => expect(screen.getByText(/No pods or workloads found/)).toBeTruthy());
  expect(mocks.namespaceLoad).toHaveBeenCalledTimes(2);
});

it("retains the workload target when opened from a resource", async () => {
  await mount();
  expect(screen.queryByLabelText("Resource")).toBeNull();
  expect(mocks.resolve.mock.calls[0][0]).toEqual(target);
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
  expect(screen.getByText("Loading logs…").querySelector('[data-icon="autorenew"]')).toBeTruthy();
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
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const severity = screen
    .getByLabelText("Log line details")
    .querySelector(".power-logs-detail-level .power-logs-level-label");
  expect(severity?.textContent).toBe("INFO");
  expect(severity?.getAttribute("data-level")).toBe("info");
  const copy = screen.getByRole("button", { name: "Copy structured JSON" });
  fireEvent.click(copy);
  expect(mocks.copy).toHaveBeenCalledWith(JSON.stringify(json, null, 2));
  expect(tooltipText(copy)).toBe(fails ? "Unable to copy JSON" : "Copied");
  expect(copy.querySelector(`[data-icon="${fails ? "content_copy" : "check"}"]`)).toBeTruthy();
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
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  expect(JSON.parse(screen.getByLabelText("Log line details").querySelector(".power-log-json")!.textContent!)).toEqual({
    reason: "timeout",
  });
  fireEvent.change(screen.getByLabelText("Container source"), { target: { value: "container:application" } });
  expect(screen.getByText("No matching log lines")).toBeTruthy();
});

it("expands only the chosen stream and keeps details separate from surrounding lines", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([
      record(0, { message: "before" }),
      record(1, { message: "other container", container: "sidecar" }),
      record(2, { message: "needle", level: "error" }),
      record(3, { message: "previous process", previous: true }),
      record(4, { message: "after" }),
      record(5, { message: "other pod", podUid: "another-pod" }),
    ]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.change(screen.getByLabelText("Search log messages"), { target: { value: "needle" } });
  fireEvent.change(screen.getByLabelText("Log level"), { target: { value: "error" } });
  expect(screen.queryByLabelText("Search context")).toBeNull();
  expect(view.container.querySelectorAll(".power-log-row")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Show surrounding lines" }));
  expect(screen.queryByLabelText("Log line details")).toBeNull();
  const rows = [...view.container.querySelectorAll(".power-log-row")];
  expect(rows.map((row) => row.querySelector(".power-log-message")?.textContent)).toEqual([
    "before",
    "needle",
    "after",
  ]);
  expect(view.container.querySelectorAll("[data-search-match=true]")).toHaveLength(1);
  expect(view.container.querySelectorAll("[data-context=true]")).toHaveLength(2);
  const expanded = screen.getByRole("button", { name: "Hide surrounding lines" });
  expect(expanded.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(rows[0].querySelector(".power-log-open")!);
  expect(screen.getByLabelText("Log line details").textContent).toContain("before");
  expect(expanded.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(expanded);
  expect(view.container.querySelectorAll(".power-log-row")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Show surrounding lines" }));
  fireEvent.change(screen.getByLabelText("Log level"), { target: { value: "info" } });
  expect(screen.queryByRole("button", { name: "Hide surrounding lines" })).toBeNull();
  expect(screen.getByText("No matching log lines")).toBeTruthy();
});

it("bounds each expansion to five neighbors and independently collapses overlapping anchors", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords(
      Array.from({ length: 31 }, (_, index) =>
        record(index, {
          message: [8, 11, 28].includes(index) ? `needle ${index}` : `neighbor ${index}`,
        }),
      ),
    );
    return { notes: [], partial: false };
  });
  const view = await mount();
  const row = (message: string) => screen.getByText(message).closest(".power-log-row")!;
  const toggle = (message: string) => fireEvent.click(row(message).querySelector(".power-log-context")!);
  const messages = () => {
    fireEvent.scroll(screen.getByLabelText("Log lines"), { target: { scrollTop: 0 } });
    return [...view.container.querySelectorAll(".power-log-message")].map((node) => node.textContent);
  };
  fireEvent.change(screen.getByLabelText("Search log messages"), { target: { value: "needle" } });
  toggle("needle 8");
  expect(messages()).toHaveLength(12);
  expect(messages()).toContain("neighbor 3");
  expect(messages()).toContain("neighbor 13");
  expect(messages()).not.toContain("neighbor 2");
  expect(messages()).not.toContain("neighbor 14");
  expect(messages()).not.toContain("neighbor 27");
  toggle("needle 11");
  expect(messages()).toHaveLength(15);
  expect(new Set(messages()).size).toBe(messages().length);
  toggle("needle 8");
  expect(messages()).toHaveLength(12);
  expect(messages()).not.toContain("neighbor 3");
  expect(messages()).toContain("neighbor 6");
  expect(row("needle 11").querySelector(".power-log-context")?.getAttribute("aria-expanded")).toBe("true");
  toggle("neighbor 6");
  expect(messages()).toContain("neighbor 1");
  toggle("needle 11");
  expect(messages()).toContain("neighbor 1");
  expect(messages()).not.toContain("neighbor 16");
  fireEvent.change(screen.getByLabelText("Search log messages"), { target: { value: "needle 28" } });
  expect(messages()).toEqual(["needle 28"]);
  expect(screen.queryByRole("button", { name: "Hide surrounding lines" })).toBeNull();
  toggle("needle 28");
  expect(screen.getByRole("button", { name: "Hide surrounding lines" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Hide surrounding lines" })).toBeNull());
  expect(messages()).toEqual(["needle 28"]);
});

it("adds nested field columns to every live row and removes them from either action", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([
      record(0, { fieldsJson: '{"request":{"status":200},"request.status":false}' }),
      record(1, { fieldsJson: '{"request":{"status":null},"request.status":0}' }),
      record(2),
    ]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  fireEvent.focus(within(detail).getByText('"status"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Show field as column" }));
  const values = () => [...view.container.querySelectorAll(".power-log-column-value")].map((cell) => cell.textContent);
  expect(values()).toEqual(["200", "null", "—"]);
  const firstValue = view.container.querySelector(".power-log-column-value")!;
  expect(firstValue.hasAttribute("title")).toBe(false);
  expect(tooltipText(firstValue)).toBe("200");
  const statusHeading = screen.getByRole("button", { name: 'Remove column $["request"]["status"]' });
  expect(within(statusHeading).getByText("status")).toBeTruthy();
  expect(statusHeading.hasAttribute("title")).toBe(false);
  expect(tooltipText(statusHeading)).toBe('$["request"]["status"]');
  expect(screen.queryByLabelText("Live JSON filters")?.textContent ?? "").not.toContain("status");
  fireEvent.focus(within(detail).getByText('"request.status"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Show field as column" }));
  expect(values()).toEqual(["200", "false", "null", "0", "—", "—"]);
  fireEvent.click(screen.getByRole("button", { name: 'Remove column $["request"]["status"]' }));
  expect(values()).toEqual(["false", "0", "—"]);
  fireEvent.focus(within(detail).getByText('"request.status"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Hide field column" }));
  expect(values()).toEqual([]);
  expect(screen.queryByLabelText("Displayed log columns")).toBeNull();
});

it("limits live field columns to eight and allows replacement after removal", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([
      record(0, {
        fieldsJson: JSON.stringify(
          Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index}`, index])),
        ),
      }),
    ]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  const add = (index: number) => {
    fireEvent.focus(within(detail).getByText(`"field${index}"`));
    fireEvent.click(within(detail).getByRole("button", { name: "Show field as column" }));
  };
  for (let index = 0; index < 9; index++) add(index);
  expect(view.container.querySelectorAll(".power-log-column-heading")).toHaveLength(8);
  expect(screen.queryByRole("button", { name: 'Remove column $["field8"]' })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: 'Remove column $["field0"]' }));
  add(8);
  expect(view.container.querySelectorAll(".power-log-column-heading")).toHaveLength(8);
  expect(screen.getByRole("button", { name: 'Remove column $["field8"]' })).toBeTruthy();
});

it("combines JSON field inclusions and exclusions with AND and removes individual filters", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([
      record(0, { fieldsJson: '{"status":200,"service":"api"}' }),
      record(1, { fieldsJson: '{"status":500,"service":"api"}' }),
      record(2, { fieldsJson: '{"status":200,"service":"worker"}' }),
    ]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  fireEvent.focus(within(detail).getByText('"status"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Include value" }));
  expect(screen.getByText("2 matching lines")).toBeTruthy();
  fireEvent.focus(within(detail).getByText('"service"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Include value" }));
  expect(screen.getByText("1 matching lines")).toBeTruthy();
  fireEvent.focus(within(detail).getByText('"status"'));
  fireEvent.click(within(detail).getByRole("button", { name: "Exclude value" }));
  expect(screen.getByText("1 matching lines")).toBeTruthy();
  const filters = screen.getByLabelText("Live JSON filters");
  expect(within(filters).getAllByRole("button")).toHaveLength(2);
  expect(filters.textContent).toContain("!= 200");
  fireEvent.click(within(detail).getByRole("button", { name: "Include value" }));
  expect(within(filters).getAllByRole("button")).toHaveLength(2);
  expect(filters.textContent).not.toContain("!= 200");
  fireEvent.click(within(filters).getAllByRole("button")[0]);
  expect(screen.getByText("2 matching lines")).toBeTruthy();
});

it("adds SQL JSON conditions to the visible query with AND and restores the base when removed", async () => {
  mocks.query.mockResolvedValue({
    columns: ["fieldsJson"],
    rows: [['{"status":200,"service":"api"}']],
    truncated: false,
    elapsedMs: 1,
  });
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  const base = (screen.getByLabelText("SQL query") as HTMLTextAreaElement).value;
  const key = () => {
    fireEvent.click(view.container.querySelector("tbody tr")!);
    return screen.getByLabelText("Log line details").querySelector<HTMLElement>('[data-token="key"]')!;
  };
  fireEvent.mouseEnter(key());
  fireEvent.click(screen.getByRole("button", { name: "Include value" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toContain('"__power_rows"');
  expect(screen.getByLabelText("SQL JSON filters").textContent).toContain("AND");
  fireEvent.click(view.container.querySelector("tbody tr")!);
  const serviceKey = [
    ...screen.getByLabelText("Log line details").querySelectorAll<HTMLElement>('[data-token="key"]'),
  ].find((el) => el.textContent === '"service"')!;
  fireEvent.mouseEnter(serviceKey);
  fireEvent.click(screen.getByRole("button", { name: "Exclude value" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  const filters = screen.getByLabelText("SQL JSON filters");
  expect(within(filters).getAllByRole("button")).toHaveLength(2);
  fireEvent.click(within(filters).getAllByRole("button")[1]);
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  fireEvent.click(within(screen.getByLabelText("SQL JSON filters")).getAllByRole("button")[0]);
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(5));
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe(base);
});

it("replaces opposite SQL filters for the same field and value without duplicating conditions", async () => {
  mocks.query.mockResolvedValue({
    columns: ["fieldsJson"],
    rows: [['{"status":200}']],
    truncated: false,
    elapsedMs: 1,
  });
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  for (const [index, action] of ["Include value", "Exclude value", "Include value"].entries()) {
    fireEvent.click(view.container.querySelector("tbody tr")!);
    fireEvent.focus(screen.getByLabelText("Log line details").querySelector<HTMLElement>('[data-token="key"]')!);
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(index + 2));
    await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
    const filters = screen.getByLabelText("SQL JSON filters");
    expect(within(filters).getAllByRole("button")).toHaveLength(1);
    expect(filters.textContent).toContain(action === "Exclude value" ? "!= 200" : "= 200");
    if (action === "Include value") expect(filters.textContent).not.toContain("!= 200");
  }
});

it.each([
  ["payload", "PAYLOAD"],
  ["x", "x", "x:1"],
])("rejects SQL JSON filtering when SQLite column names are ambiguous: %j", async (...columns) => {
  mocks.query.mockResolvedValue({
    columns,
    rows: [columns.map((_, index) => JSON.stringify({ a: index + 1 }))],
    truncated: false,
    elapsedMs: 1,
  });
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  const original = (screen.getByLabelText("SQL query") as HTMLTextAreaElement).value;
  fireEvent.click(view.container.querySelector("tbody tr")!);
  const keys = screen.getByLabelText("Log line details").querySelectorAll<HTMLElement>('[data-token="key"]');
  fireEvent.mouseEnter(keys[keys.length - 1]);
  fireEvent.click(screen.getByRole("button", { name: "Include value" }));
  expect(screen.getByRole("alert").textContent).toContain("unique result column names");
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe(original);
});

it("does not mutate SQL or expose filter actions while a new capture is pending", async () => {
  const pending = deferred<LogCapture>();
  mocks.create.mockReturnValue(pending.promise);
  mocks.query.mockResolvedValue({ columns: ["fieldsJson"], rows: [['{"value":1}']], truncated: false, elapsedMs: 1 });
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(view.container.querySelector("tbody tr")).not.toBeNull());
  const original = (screen.getByLabelText("SQL query") as HTMLTextAreaElement).value;
  fireEvent.click(screen.getByRole("button", { name: "Capture logs" }));
  fireEvent.mouseEnter(view.container.querySelector<HTMLElement>('td [data-token="key"]')!);
  expect(screen.queryByRole("button", { name: "Include value" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Exclude value" })).toBeNull();
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe(original);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(snapshot));
  await waitFor(() => expect(mocks.finish).toHaveBeenCalled());
});

it("hides native logs for workloads without a native view", async () => {
  await mount();
  expect(screen.queryByRole("button", { name: "Native logs" })).toBeNull();
  expect(mocks.nativeWorkload).not.toHaveBeenCalled();
  expect(mocks.nativePod).not.toHaveBeenCalled();
});

it("shows SQL errors below the editor and includes the executed failure in AI context", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Check SQL syntax, column names and supported functions"),
  );
  expect(view.container.querySelector(".power-logs-results table")).toBeNull();
  expect(screen.queryByRole("button", { name: "Review AI context" })).toBeNull();
  const editor = screen.getByLabelText("SQL query");
  expect(editor.compareDocumentPosition(screen.getByRole("alert")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(editor, { target: { value: "SELECT changed_draft FROM logs" } });
  fireEvent.click(screen.getByRole("button", { name: "Open AI assistant" }));
  const finding = mocks.explain.mock.calls[0][0];
  expect(finding.source).toBe("logs");
  expect(finding.summary).toContain("Query failed");
  expect(finding.summary).toContain("Check SQL syntax");
  expect(finding.summary).not.toContain("changed_draft");
});

it("reviews executed SQL and its capture identity with ordinary values after editing SQL", async () => {
  const pending = deferred<any>();
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
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
  expect(preview).toContain("private-test-value");
  expect(mocks.explain.mock.calls[0][0].resource.name).toBe("captured-application");
});

it("requires confirmation before deleting or making a snapshot persistent", async () => {
  mocks.confirm.mockImplementation(() => {});
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  fireEvent.click(screen.getByRole("button", { name: `Delete snapshot ${snapshot.target.name}` }));
  expect(mocks.delete).not.toHaveBeenCalled();
  const deletion = mocks.confirm.mock.calls[0][0];
  const deletedLabel = render(deletion.labelOk);
  expect(deletedLabel.container.textContent).toBe("Delete snapshot");
  expect(deletedLabel.container.querySelector('[data-icon="delete_outline"]')).toBeTruthy();
  deletedLabel.unmount();
  const deletedMessage = render(deletion.message);
  expect(deletedMessage.container.children).toHaveLength(1);
  expect(deletedMessage.container.firstElementChild?.textContent).toBe(
    `Delete snapshot ${snapshot.target.name}? This cannot be undone.`,
  );
  deletedMessage.unmount();
  expect(deletion.okButtonProps.className).toContain("power-logs-confirm-delete");
  fireEvent.click(screen.getByRole("button", { name: `Keep snapshot ${snapshot.target.name}` }));
  expect(mocks.setPersistent).not.toHaveBeenCalled();
  const confirmation = mocks.confirm.mock.calls[1][0];
  const keptLabel = render(confirmation.labelOk);
  expect(keptLabel.container.textContent).toBe("Keep snapshot");
  expect(keptLabel.container.querySelector('[data-icon="push_pin"]')).toBeTruthy();
  keptLabel.unmount();
  const keptMessage = render(confirmation.message);
  expect(keptMessage.container.children).toHaveLength(1);
  expect(keptMessage.container.firstElementChild?.textContent).toContain(`Keep snapshot ${snapshot.target.name} until`);
  keptMessage.unmount();
  await act(async () => confirmation.ok());
  expect(mocks.setPersistent).toHaveBeenCalledWith(snapshot.id, true);
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await screen.findByText("captured log message");
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  const deleteButton = screen.getByRole("button", { name: `Delete snapshot ${snapshot.target.name}` });
  expect(tooltipText(deleteButton)).toBe("Delete snapshot (Alt+Delete)");
  expect(tooltipText(deleteButton.closest(".power-logs-snapshot-option")!)).toBe("");
  fireEvent.click(deleteButton);
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
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

it.each([
  ["create", false],
  ["create", true],
  ["append", false],
  ["append", true],
  ["finish", false],
  ["finish", true],
] as const)("shows actionable storage errors from capture %s (IPC envelope: %s)", async (stage, envelope) => {
  await mount();
  const collecting: LogCapture = { ...snapshot, state: "collecting" };
  mocks.create.mockResolvedValue(collecting);
  mocks.append.mockResolvedValue(collecting);
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0)]);
    return { notes: [], partial: false };
  });
  const message = envelope
    ? `Error invoking remote method '${POWER_LOGS_CHANNEL}': Error: ${POWER_LOGS_STORAGE_FULL}`
    : POWER_LOGS_STORAGE_FULL;
  mocks[stage].mockRejectedValueOnce(new Error(message));
  if (stage === "finish") mocks.list.mockResolvedValue([collecting]);
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByText("Capture logs"));
  expect(await screen.findByText(POWER_LOGS_STORAGE_FULL)).toBeTruthy();
  if (stage === "finish") {
    await waitFor(() => expect(screen.queryByText("Stop & keep partial")).toBeNull());
    fireEvent.click(screen.getByLabelText("Capture snapshot"));
    const remove = screen.getByRole("button", {
      name: `Delete snapshot ${collecting.target.name}`,
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    mocks.delete.mockResolvedValueOnce(true);
    mocks.list.mockResolvedValueOnce([]);
    fireEvent.click(remove);
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith(collecting.id));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `Delete snapshot ${collecting.target.name}` })).toBeNull(),
    );
  }
});

it.each([
  false,
  true,
])("shows storage quota errors when saving retention or SQL drafts (IPC envelope: %s)", async (envelope) => {
  await mount();
  const message = envelope
    ? `Error invoking remote method '${POWER_LOGS_CHANNEL}': Error: ${POWER_LOGS_STORAGE_FULL}`
    : POWER_LOGS_STORAGE_FULL;
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  mocks.setPersistent.mockRejectedValueOnce(new Error(message));
  fireEvent.click(screen.getByRole("button", { name: `Keep snapshot ${snapshot.target.name}` }));
  expect(await screen.findByText(POWER_LOGS_STORAGE_FULL)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await screen.findByText("captured log message");
  await waitFor(() => expect(screen.queryByText(POWER_LOGS_STORAGE_FULL)).toBeNull());
  mocks.saveSql.mockRejectedValueOnce(new Error(message));
  fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: "SELECT unsaved_edit" } });
  expect(await screen.findByText(POWER_LOGS_STORAGE_FULL)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("SELECT unsaved_edit");
});

it("preserves append quota failures when the collector reports cancellation and finishes a partial capture", async () => {
  await mount();
  mocks.append.mockRejectedValueOnce(new Error(POWER_LOGS_STORAGE_FULL));
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    try {
      await options.onRecords([record(0)]);
    } catch {
      throw new Error("Log collection canceled");
    }
    return { notes: [], partial: false };
  });
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByText("Capture logs"));
  expect(await screen.findByText(POWER_LOGS_STORAGE_FULL)).toBeTruthy();
  expect(mocks.finish).toHaveBeenCalledWith(snapshot.id, true, expect.any(Array));
  await screen.findByText("captured log message");
  expect(screen.getByText(POWER_LOGS_STORAGE_FULL)).toBeTruthy();
});

it("keeps unknown capture failures generic", async () => {
  await mount();
  mocks.create.mockRejectedValueOnce(new Error(`private failure ${POWER_LOGS_STORAGE_FULL}`));
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByText("Capture logs"));
  expect(
    await screen.findByText("Could not create a capture. Delete an old snapshot or check the log service."),
  ).toBeTruthy();
  expect(screen.queryByText(POWER_LOGS_STORAGE_FULL)).toBeNull();
  expect(screen.queryByText(/private failure/)).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  expect(await screen.findByText("captured log message")).toBeTruthy();
  expect(mocks.query.mock.calls[0][2]).toContain("SELECT timestamp, level, message");
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
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
  mocks.list.mockResolvedValue([{ ...snapshot, target }]);
  const view = await mount();
  expect(screen.queryByRole("button", { name: "Capture logs" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  act(() => {
    window.dispatchEvent(new CustomEvent("power-logs-sql-draft", { detail: { sql: "SELECT count(*) FROM logs" } }));
  });
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("SELECT count(*) FROM logs");
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.getByRole("button", { name: "Capture logs" })).toBeTruthy();
  expect(mocks.query).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).value).toBe(snapshot.id);
  view.unmount();
  await waitFor(() => expect(mocks.saveSql).toHaveBeenCalledWith(snapshot.id, "SELECT count(*) FROM logs"));
});

it("prevents capture collection while a SQL query is pending", async () => {
  const pending = deferred<any>();
  mocks.query.mockReturnValue(pending.promise);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
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
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
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
  expect(mocks.query.mock.calls[0][2]).toContain("SELECT timestamp, level, message");
});

it("explains an empty successful SQL result", async () => {
  mocks.query.mockResolvedValue({ columns: ["message"], rows: [], truncated: false, elapsedMs: 1 });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  expect(await screen.findByText(/This query returned no rows/)).toBeTruthy();
  expect(screen.getByText(/0 rows/)).toBeTruthy();
});

it("locks snapshot controls immediately while capture creation is pending", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
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

it("builds Recent and JSON presets from original fields without running draft queries", async () => {
  mocks.discover.mockResolvedValue({
    columns: ["key"],
    rows: [["msg"], ["levelname"]],
    truncated: false,
    elapsedMs: 1,
  });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalled());
  const editor = screen.getByLabelText("SQL query") as HTMLTextAreaElement;
  expect(editor.value).toBe(
    "SELECT timestamp, level, message, container, pod FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200",
  );
  expect(mocks.discover).not.toHaveBeenCalled();
  const calls = mocks.query.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "SQL · JSON" }));
  await waitFor(() => expect(editor.value).toContain("WHERE fieldsJson IS NOT NULL"));
  expect(editor.value).toContain("$.msg");
  expect(editor.value).not.toContain("levelname");
  expect(mocks.query).toHaveBeenCalledTimes(calls);
});
it("keeps triple-click selection inside the SQL editor", async () => {
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalled());
  const editor = screen.getByLabelText("SQL query") as HTMLTextAreaElement;
  fireEvent.mouseDown(editor, { detail: 3 });
  expect(editor.selectionStart).toBe(0);
  expect(editor.selectionEnd).toBe(editor.value.length);
  expect(window.getSelection()?.toString()).toBe("");
});

it("preserves an edited SQL draft while JSON schema discovery is pending", async () => {
  const pending = deferred<any>();
  mocks.discover.mockReturnValue(pending.promise);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "SQL · JSON" }));
  await waitFor(() => expect(mocks.discover).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("SQL query"), { target: { value: "SELECT 42 AS custom" } });
  await act(async () => pending.resolve({ columns: ["key"], rows: [["msg"]], truncated: false, elapsedMs: 1 }));
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("SELECT 42 AS custom");
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("SQL draft changed");
});

it("restores each snapshot draft including blank SQL without executing it", async () => {
  const other = { ...snapshot, id: "capture-b", lastSql: "SELECT 7" };
  mocks.list.mockResolvedValue([{ ...snapshot, lastSql: "SELECT 42" }, other]);
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  const choose = (id: string) => fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: id } });
  const editor = () => screen.getByLabelText("SQL query") as HTMLTextAreaElement;
  choose(snapshot.id);
  expect(editor().value).toBe("SELECT 42");
  fireEvent.change(editor(), { target: { value: "" } });
  choose(other.id);
  expect(editor().value).toBe("SELECT 7");
  await waitFor(() => expect(mocks.saveSql).toHaveBeenCalledWith(snapshot.id, ""));
  fireEvent.change(editor(), { target: { value: "SELECT 99" } });
  choose(snapshot.id);
  expect(editor().value).toBe("");
  choose(other.id);
  expect(editor().value).toBe("SELECT 99");
  fireEvent.change(editor(), { target: { value: "SELECT 100" } });
  view.unmount();
  await waitFor(() => expect(mocks.saveSql).toHaveBeenCalledWith(other.id, "SELECT 100"));
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.discover).not.toHaveBeenCalled();
});

it("keeps full JSON instead of losing fields when schema discovery is truncated", async () => {
  mocks.discover.mockResolvedValue({ columns: ["key"], rows: [["msg"]], truncated: true, elapsedMs: 1 });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "SQL · JSON" }));
  await waitFor(() =>
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe(
      "SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100",
    ),
  );
});

it("restores a persisted blank draft after reopening without executing", async () => {
  mocks.list.mockResolvedValue([{ ...snapshot, target, lastSql: "" }]);
  const view = await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("");
  view.unmount();
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("");
  expect(mocks.query).not.toHaveBeenCalled();
});

it("offers confirmed global saved-snapshot cleanup when the saved pool is full", async () => {
  mocks.setPersistent.mockRejectedValue(
    new Error("Saved snapshot limit reached. Delete a saved snapshot before keeping another."),
  );
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  fireEvent.click(screen.getByRole("button", { name: `Keep snapshot ${snapshot.target.name}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Clear saved snapshots" })).toBeTruthy());
  mocks.confirm.mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Clear saved snapshots" }));
  expect(mocks.clearPersistent).not.toHaveBeenCalled();
  const confirmation = mocks.confirm.mock.calls.at(-1)![0];
  const message = render(confirmation.message);
  expect(message.container.textContent).toContain("all clusters");
  message.unmount();
  await act(async () => confirmation.ok());
  expect(mocks.clearPersistent).toHaveBeenCalledOnce();
});

it("shows incomplete snapshot notes in the footer tooltip", async () => {
  mocks.list.mockResolvedValue([{ ...snapshot, state: "partial", notes: ["A source was unavailable"] }]);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: snapshot.id } });
  const note = screen.getByText("Incomplete snapshot").closest('[role="note"]')!;
  expect(note.closest(".power-logs-footer")).not.toBeNull();
  expect(tooltipText(note)).toBe("A source was unavailable");
  expect(screen.queryByText(/Snapshot notes/)).toBeNull();
});

it("clears a selected saved snapshot and its results after global saved cleanup", async () => {
  const saved = { ...snapshot, persistent: true };
  const temporary = { ...snapshot, id: "temporary", target: { ...snapshot.target, name: "temporary" } };
  mocks.list.mockResolvedValue([saved, temporary]);
  mocks.setPersistent.mockRejectedValue(new Error("Saved snapshot limit reached"));
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: saved.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  await waitFor(() => expect(screen.getByText("captured log message")).toBeTruthy());
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  fireEvent.click(screen.getByRole("button", { name: "Keep snapshot temporary" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Clear saved snapshots" })).toBeTruthy());
  mocks.list.mockResolvedValue([temporary]);
  fireEvent.click(screen.getByRole("button", { name: "Clear saved snapshots" }));
  await waitFor(() => expect((screen.getByLabelText("Capture snapshot") as HTMLSelectElement).value).toBe(""));
  expect(screen.queryByText("captured log message")).toBeNull();
});

it("places live loading errors after the filters and SQL errors after the editor", async () => {
  mocks.history.mockRejectedValue(new Error("unavailable"));
  const view = await mount();
  const alert = await screen.findByRole("alert");
  const filters = view.container.querySelector(".power-logs-filters")!;
  expect(filters.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  const editor = screen.getByLabelText("SQL query");
  expect(editor.compareDocumentPosition(screen.getByRole("alert")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it.each([false, true])("uses distinct snapshot pin icons for persistent state %s", async (persistent) => {
  mocks.list.mockResolvedValue([{ ...snapshot, persistent }]);
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.click(screen.getByLabelText("Capture snapshot"));
  const button = screen.getByRole("button", {
    name: `${persistent ? "Allow expiration for" : "Keep"} snapshot ${snapshot.target.name}`,
  });
  expect(button.getAttribute("aria-pressed")).toBe(String(persistent));
  expect(button.querySelector(`[data-icon="${persistent ? "push_off" : "push_pin"}"]`)).toBeTruthy();
});

it("shows live source metadata in separate labeled rows and places the full timestamp before fields", async () => {
  const liveTarget = { ...target, namespace: "live-space" };
  window.history.replaceState({}, "", `/?target=${encodeURIComponent(JSON.stringify(liveTarget))}`);
  mocks.objects = [{ kind: liveTarget.kind, metadata: { ...liveTarget } }];
  const line = record(0, { fieldsJson: '{"nested":{"value":1}}' });
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([line]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  const pod = detail.querySelector(".power-logs-detail-pod")!;
  const namespace = detail.querySelector(".power-logs-detail-namespace")!;
  const level = detail.querySelector(".power-logs-detail-level")!;
  expect(pod.querySelector("strong")?.textContent).toBe("Pod:");
  expect(namespace.querySelector("strong")?.textContent).toBe("Namespace:");
  expect(level.querySelector("strong")?.textContent).toBe("Level:");
  expect(new Set([pod, namespace, level]).size).toBe(3);
  expect(pod.textContent).toContain(line.pod);
  expect(namespace.textContent).toContain("live-space");
  expect(level.textContent).toContain("INFO");
  expect(detail.textContent).not.toContain("Container:");
  expect(
    Array.from(pod.querySelectorAll("[title]"))
      .map((node) => node.getAttribute("title"))
      .join(" "),
  ).toContain(`Container: ${line.container}`);
  const separator = detail.querySelector("hr.power-logs-detail-separator")!;
  const message = within(detail).getByText(line.message);
  expect(separator.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const separators = detail.querySelectorAll("hr.power-logs-detail-separator");
  expect(separators).toHaveLength(2);
  expect(message.compareDocumentPosition(separators[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    separators[1].compareDocumentPosition(within(detail).getByText("Structured fields")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const time = detail.querySelector(".power-logs-detail-time")!;
  expect(level.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(time.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...time.querySelectorAll(".power-logs-detail-timestamp > span")].map((part) => part.textContent)).toEqual(
    formatDateTime(line.timestamp!).split("  "),
  );
  expect(time.querySelector("strong")?.textContent).toBe("Time:");
  expect(time.textContent).toContain(formatDateTime(line.timestamp!));
  expect(
    time.compareDocumentPosition(within(detail).getByText("Structured fields")) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it.each([
  false,
  true,
])("copies only the pod name without changing JSON and handles clipboard failures (fails: %s)", async (fails) => {
  const fieldsJson = '{"nested":{"value":1}}';
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0, { fieldsJson })]);
    return { notes: [], partial: false };
  });
  if (fails)
    mocks.copy.mockImplementationOnce(() => {
      throw new Error("private clipboard diagnostic");
    });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  const json = detail.querySelector(".power-log-json")!.textContent;
  const copy = within(detail).getByRole("button", { name: "Copy pod name" });
  fireEvent.click(copy);
  expect(mocks.copy).toHaveBeenCalledTimes(1);
  expect(mocks.copy).toHaveBeenCalledWith(source.pod);
  expect(tooltipText(copy)).toBe(fails ? "Unable to copy pod name" : "Copied");
  expect(copy.querySelector('[data-icon="check"]') !== null).toBe(!fails);
  expect(detail.textContent).not.toContain("private clipboard diagnostic");
  expect(detail.querySelector(".power-log-json")!.textContent).toBe(json);
  expect(JSON.parse(json!)).toEqual(JSON.parse(fieldsJson));
  expect(tooltipText(within(detail).getByRole("button", { name: "Copy structured JSON" }))).toBe(
    "Copy structured JSON",
  );
});

it.each([
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
])("shows unavailable time for invalid live timestamps (%s)", async (timestamp) => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0, { timestamp })]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  expect(screen.getByLabelText("Log line details").querySelector(".power-logs-detail-time")?.textContent).toContain(
    "Unavailable",
  );
});

it("uses the selected SQL capture namespace and suppresses copying absent pod names", async () => {
  const captured = { ...snapshot, target: { ...snapshot.target, namespace: "capture-space" } };
  mocks.list.mockResolvedValue([captured]);
  mocks.query.mockResolvedValue({ columns: ["message"], rows: [["query row"]], elapsedMs: 1, truncated: false });
  await mount();
  fireEvent.click(screen.getByRole("tab", { name: "SQL" }));
  fireEvent.change(screen.getByLabelText("Capture snapshot"), { target: { value: captured.id } });
  fireEvent.click(screen.getByRole("button", { name: "Run query" }));
  fireEvent.click(await screen.findByLabelText("Open SQL row 1"));
  const detail = screen.getByLabelText("Log line details");
  expect(detail.querySelector(".power-logs-detail-namespace")?.textContent).toContain("capture-space");
  expect(detail.querySelector(".power-logs-detail-namespace")?.textContent).not.toContain(target.namespace);
  expect(within(detail).queryByRole("button", { name: "Copy pod name" })).toBeNull();
  expect(detail.querySelector(".power-logs-detail-time")?.textContent).toContain("Unavailable");
});

it("copies namespace and displayed level independently with success feedback", async () => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0, { level: "error" })]);
    return { notes: [], partial: false };
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  const buttons = [
    ["Copy pod name", source.pod],
    ["Copy namespace", target.namespace],
    ["Copy log level", "ERROR"],
  ];
  for (const [name, value] of buttons) {
    const copy = within(detail).getByRole("button", { name });
    expect(tooltipText(copy)).toBe(name);
    fireEvent.click(copy);
    expect(mocks.copy).toHaveBeenLastCalledWith(value);
    expect(tooltipText(copy)).toBe("Copied");
    expect(copy.querySelector('[data-icon="check"]')).toBeTruthy();
  }
  expect(mocks.copy).toHaveBeenCalledTimes(3);
});

it.each([
  ["Copy namespace", "namespace"],
  ["Copy log level", "log level"],
])("reports safe clipboard errors for %s", async (name, field) => {
  mocks.history.mockImplementation(async (_sources, _transport, options) => {
    await options.onRecords([record(0)]);
    return { notes: [], partial: false };
  });
  mocks.copy.mockImplementationOnce(() => {
    throw new Error("private clipboard diagnostic");
  });
  const view = await mount();
  fireEvent.click(view.container.querySelector(".power-log-open")!);
  const detail = screen.getByLabelText("Log line details");
  const copy = within(detail).getByRole("button", { name });
  fireEvent.click(copy);
  expect(tooltipText(copy)).toBe(`Unable to copy ${field}`);
  expect(copy.querySelector('[data-icon="check"]')).toBeNull();
  expect(detail.textContent).not.toContain("private clipboard diagnostic");
});
