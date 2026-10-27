// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PowerHelmPage } from "./helm";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  copy: vi.fn(),
  helmEnabled: true,
  readOnly: false,
  readOnlyStore: undefined as { enabled: boolean } | undefined,
  appVersions: {} as Record<string, string>,
  indexState: { completed: 0, total: 0, errors: 0, truncated: false },
}));
vi.mock("./helm-version-index", () => ({
  useHelmVersionIndex: () => ({
    versionFor: (release: any) => ({ appVersion: mocks.appVersions[release.name] }),
    ...mocks.indexState,
  }),
}));
vi.mock("./helm-app-version", () => ({
  HelmAppVersionCell: () => (
    <button type="button" aria-label="Retry app version">
      —
    </button>
  ),
}));
vi.mock("./helm-code-view", () => ({
  openHelmDocumentFind: () => false,
  HelmCodeView: ({ value, readOnly = true, onChange, ariaLabel }: any) =>
    readOnly ? (
      <pre aria-label={ariaLabel}>{value}</pre>
    ) : (
      <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
    ),
  HelmRevisionDiff: ({ before, after, beforeLabel, afterLabel }: any) => (
    <section aria-label="Revision comparison">
      <h4>{beforeLabel}</h4>
      <pre>{before}</pre>
      <h4>{afterLabel}</h4>
      <pre>{after}</pre>
    </section>
  ),
}));
vi.mock("../common/store/helm-preferences-store", () => ({
  HelmPreferencesStore: { getInstanceOrCreate: () => ({ enabled: mocks.helmEnabled }) },
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke }, clipboard: { writeText: mocks.copy } }));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => mocks.readOnlyStore ?? { enabled: mocks.readOnly } },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => ({ enabled: true }) },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: {
      activeCluster: { get: () => ({ metadata: { uid: "test-cluster" }, spec: { accessibleNamespaces: ["sample"] } }) },
    },
    Navigation: { navigate: vi.fn() },
    Component: {
      Drawer: ({ title, children, onClose }: any) => (
        <div className="Drawer">
          <div>{title}</div>
          <button type="button" aria-label="Close" onClick={onClose}>
            Close
          </button>
          {children}
        </div>
      ),
      Icon: ({ material }: any) => <span>{material}</span>,
      Checkbox: ({ label, value, disabled, onChange }: any) => (
        <label>
          <input
            type="checkbox"
            checked={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}
        </label>
      ),
      Button: ({ label, children, ...props }: any) => <button {...props}>{label ?? children}</button>,
      Select: ({ value, options, onChange, "aria-label": label }: any) => (
        <select aria-label={label} value={value} onChange={(event) => onChange({ value: event.target.value })}>
          {options.map((option: any) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ),
      ConfirmDialog: { open: mocks.confirm },
    },
  },
}));
const release = {
  name: "sample-release",
  namespace: "sample",
  revision: 2,
  status: "deployed",
  secretName: "sample-secret",
  uid: "sample-secret-uid-2",
};
const listing = { ok: true, releases: [release], fetchedAt: 1000, contextId: "a".repeat(64) };
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  mocks.helmEnabled = true;
  mocks.readOnly = false;
  mocks.readOnlyStore = undefined;
  mocks.appVersions = {};
  mocks.indexState = { completed: 0, total: 0, errors: 0, truncated: false };
  mocks.invoke.mockReset();
  mocks.confirm.mockReset();
  mocks.copy.mockReset();
  mocks.invoke.mockResolvedValue(listing);
});
afterEach(cleanup);

it("centers the first-load status and cancels it without accepting late rows", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const pending = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : pending.promise,
  );
  try {
    render(<PowerHelmPage />);
    const placeholder = screen.getByRole("region", { name: "Helm releases table" });
    expect(placeholder.className).toContain("helm-initial-loading");
    expect(screen.getByText("Loading Helm releases and their current status…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel loading" }));
    expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel")).toBe(true);
    await act(async () => pending.resolve(listing));
    expect(screen.queryByRole("region", { name: "Helm releases table" })).toBeNull();
    expect(screen.queryByText("sample-release")).toBeNull();
  } finally {
    now.mockRestore();
  }
});

it("preserves rows on refresh errors and cancels obsolete namespace requests", async () => {
  const pending = deferred();
  render(<PowerHelmPage />);
  await screen.findByText("sample-release");
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel" ? Promise.resolve({ ok: true }) : pending.promise,
  );
  fireEvent.click(screen.getByText("Refresh"));
  expect(screen.getByText("sample-release")).toBeTruthy();
  await act(async () => pending.resolve({ ok: false, error: { message: "Unavailable", code: "failed" } }));
  await screen.findByText("Unavailable");
  expect(screen.getByText("sample-release")).toBeTruthy();
  const stale = deferred();
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "cancel"
      ? Promise.resolve({ ok: true })
      : request.namespace
        ? Promise.resolve({ ok: true, releases: [] })
        : stale.promise,
  );
  fireEvent.click(screen.getByText("Retry"));
  fireEvent.change(screen.getByLabelText("Helm namespace"), { target: { value: "sample" } });
  await screen.findByText("No Helm releases in sample");
  await act(async () => stale.resolve(listing));
  expect(screen.queryByText("sample-release")).toBeNull();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "cancel")).toBe(true);
});

it("loads sections and history lazily and retries failed history", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "Overview content" } }
        : request.operation === "history"
          ? { ok: false, error: { message: "History failed" } }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  await screen.findByText("Overview content");
  const details = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details");
  expect(details).toHaveLength(1);
  expect(details[0][1]).toMatchObject({
    name: release.name,
    namespace: release.namespace,
    revision: release.revision,
    section: "overview",
    contextId: listing.contextId,
  });
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "list")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "history")).toBe(false);
  fireEvent.click(screen.getByText("History"));
  await screen.findByText("History failed");
  expect(screen.queryByText("Loading…")).toBeNull();
  mocks.invoke.mockResolvedValue({ ok: true, releases: [release], rollbackAllowed: true });
  fireEvent.click(screen.getByText("Retry"));
  await screen.findByLabelText("Revision 2");
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "rollback")).toBe(false);
});

it("requires both a checkbox and native confirmation before rollback", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "Overview" } }
        : { ...listing, rollbackAllowed: true },
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  fireEvent.click(await screen.findByLabelText("Revision 2"));
  const button = screen.getByText("Roll back") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByRole("checkbox", { name: /to Revision 2 App version/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm rolling back sample-release/ }));
  fireEvent.click(button);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "rollback")).toBe(false);
  await act(async () => mocks.confirm.mock.calls[0][0].ok());
  await waitFor(() =>
    expect(
      mocks.invoke.mock.calls.some(
        ([, request]) =>
          request.operation === "rollback" &&
          request.uid === release.uid &&
          request.confirmed === true &&
          request.contextId === listing.contextId,
      ),
    ).toBe(true),
  );
});

it("clears rollback confirmation after an unknown result and refreshes reads", async () => {
  let unknown = false;
  const historyRefresh = deferred();
  mocks.invoke.mockImplementation((_channel, request) => {
    if (request.operation === "rollback") {
      unknown = true;
      return Promise.resolve({ ok: false, error: { code: "rollback-unknown", message: "Outcome unknown" } });
    }
    if (request.operation === "details") return Promise.resolve({ ok: true, detail: { content: "Overview" } });
    if (unknown && request.operation === "history") return historyRefresh.promise;
    if (unknown && request.operation === "list")
      return Promise.resolve({ ...listing, releases: [{ ...release, revision: 3, uid: "sample-secret-uid-3" }] });
    return Promise.resolve({ ...listing, rollbackAllowed: true, cached: request.operation === "history" });
  });
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  fireEvent.click(await screen.findByLabelText("Revision 2"));
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm rolling back sample-release/ }));
  fireEvent.click(screen.getByText("Roll back"));
  await act(async () => mocks.confirm.mock.calls[0][0].ok());
  await screen.findByText("Outcome unknown");
  await screen.findByText("Revision 3");
  expect(screen.getByText("Outcome unknown")).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details")).toHaveLength(1);
  expect(
    (screen.getByRole("checkbox", { name: /I confirm rolling back sample-release/ }) as HTMLInputElement).checked,
  ).toBe(false);
  expect((screen.getByLabelText("Revision 2") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByText("Roll back") as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "list")).toHaveLength(2);
  await act(async () =>
    historyRefresh.resolve({
      ...listing,
      releases: [{ ...release, revision: 3, uid: "sample-secret-uid-3" }, release],
      rollbackAllowed: true,
      cached: true,
    }),
  );
  expect(screen.getByText("Outcome unknown")).toBeTruthy();
  expect(screen.getByLabelText("Revision 3")).toBeTruthy();
  expect((screen.getByText("Roll back") as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "rollback")).toHaveLength(1);
});

it("removes cached metadata on forbidden responses", async () => {
  render(<PowerHelmPage />);
  await screen.findByText("sample-release");
  mocks.invoke.mockResolvedValue({ ok: false, error: { code: "forbidden", message: "Forbidden" } });
  fireEvent.click(screen.getByText("Refresh"));
  await screen.findByText("Forbidden");
  expect(screen.queryByText("sample-release")).toBeNull();
});

it("bounds history rows and finds old revisions without discarding selection", async () => {
  const history = Array.from({ length: 1256 }, (_, index) => ({ ...release, revision: 1256 - index }));
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "Overview" } }
        : request.operation === "history"
          ? { ok: true, releases: history, rollbackAllowed: true }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 1256");
  expect(screen.getAllByRole("radio")).toHaveLength(50);
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "2" } });
  fireEvent.click(await screen.findByLabelText("Revision 2"));
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "" } });
  expect(screen.getAllByRole("radio")).toHaveLength(50);
  expect(screen.getByText(/Selected Revision 2/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "2" } });
  expect((screen.getByLabelText("Revision 2") as HTMLInputElement).checked).toBe(true);
});

it("does not request Helm data when enhancements are disabled", () => {
  mocks.helmEnabled = false;
  render(<PowerHelmPage />);
  expect(screen.getByText("Helm enhancements are disabled")).toBeTruthy();
  expect(screen.getByLabelText("Open native Helm")).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("views historical values independently of rollback selection and compares against current metadata", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `replicas: ${request.revision}` } }
        : request.operation === "history"
          ? {
              ...listing,
              releases: [{ ...release, revision: 1, status: "superseded" }, release],
              rollbackAllowed: true,
            }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 1");
  fireEvent.click(screen.getAllByRole("button", { name: "View revision" })[0]);
  await screen.findByText("replicas: 1");
  expect(screen.getByText("Historical revision · Read only")).toBeTruthy();
  expect(screen.queryByText("Edit values")).toBeNull();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "rollback")).toBe(false);
  const beforeCompare = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details").length;
  fireEvent.click(screen.getByText("Compare with current"));
  await screen.findByLabelText("Revision comparison");
  expect(screen.getByLabelText("Revision comparison").querySelector("h4")?.parentElement?.textContent).toContain(
    "Latest · Revision 2",
  );
  const details = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details");
  expect(details).toHaveLength(beforeCompare + 1);
  expect(details.at(-1)?.[1]).toMatchObject({ revision: 2, section: "values", contextId: listing.contextId });
});

it("edits current values only after native diff confirmation and prevents duplicate apply", async () => {
  const upgrade = deferred();
  const historyRefresh = deferred();
  let refreshAttempts = 0;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "upgrade-values"
      ? upgrade.promise
      : request.operation === "history"
        ? refreshAttempts++ === 0
          ? historyRefresh.promise
          : Promise.resolve(listing)
        : Promise.resolve(
            request.operation === "details"
              ? { ok: true, detail: { content: "replicas: 2" } }
              : request.operation === "edit-options"
                ? {
                    ok: true,
                    upgradeAllowed: true,
                    chartChoices: [{ ref: "sample/chart", version: "1.0.0" }],
                    contextId: listing.contextId,
                  }
                : listing,
          ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("Values"));
  fireEvent.click(await screen.findByText("Edit values"));
  await screen.findByLabelText("Chart source");
  fireEvent.change(screen.getByLabelText("Edit current release values"), { target: { value: "replicas: 3" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect((screen.getByLabelText("Edit current release values") as HTMLTextAreaElement).value).toBe("replicas: 3");
  await waitFor(() => expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Review changes"));
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "upgrade-values")).toBe(false);
  await act(async () => {
    mocks.confirm.mock.calls[0][0].ok();
    mocks.confirm.mock.calls[0][0].ok();
  });
  const upgrades = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values");
  expect(upgrades).toHaveLength(1);
  expect(upgrades[0][1]).toMatchObject({
    revision: 2,
    chart: "sample/chart",
    values: "replicas: 3",
    confirmed: true,
    contextId: listing.contextId,
  });
  await act(async () =>
    upgrade.resolve({ ok: false, error: { message: "Upgrade outcome unknown", code: "upgrade-unknown" } }),
  );
  await screen.findByText("Upgrade outcome unknown");
  expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Refresh release"));
  const reads = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "history");
  expect(reads).toHaveLength(1);
  expect(reads[0][1]).toMatchObject({
    refresh: true,
    clusterId: "test-cluster",
    namespace: release.namespace,
    name: release.name,
    contextId: listing.contextId,
  });
  expect((screen.getByText("Refreshing…") as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(1);
  await act(async () =>
    historyRefresh.resolve({ ok: false, error: { message: "History refresh failed", code: "failed" } }),
  );
  await screen.findByText("History refresh failed");
  expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Refresh release"));
  fireEvent.click(await screen.findByText("Edit values"));
  await screen.findByLabelText("Chart source");
  fireEvent.change(screen.getByLabelText("Edit current release values"), { target: { value: "replicas: 4" } });
  const review = screen.getByText("Review changes") as HTMLButtonElement;
  expect(review.disabled).toBe(true);
  await waitFor(() => expect(review.disabled).toBe(false));
  fireEvent.click(review);
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(1);
  await act(async () => mocks.confirm.mock.calls[1][0].ok());
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(2);
});

it("blocks pending value confirmation when read-only mode is enabled", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "replicas: 2" } }
        : request.operation === "edit-options"
          ? { ok: true, upgradeAllowed: true, chartChoices: [{ ref: "sample/chart", version: "1.0.0" }] }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("Values"));
  fireEvent.click(await screen.findByText("Edit values"));
  await screen.findByLabelText("Chart source");
  fireEvent.change(screen.getByLabelText("Edit current release values"), { target: { value: "replicas: 3" } });
  await waitFor(() => expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Review changes"));
  mocks.readOnly = true;
  await act(async () => mocks.confirm.mock.calls[0][0].ok());
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "upgrade-values")).toBe(false);
});

it("does not offer editing in read-only mode or query chart sources", async () => {
  mocks.readOnly = true;
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(request.operation === "details" ? { ok: true, detail: { content: "replicas: 2" } } : listing),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("Values"));
  await screen.findByText("replicas: 2");
  expect(screen.queryByText("Edit values")).toBeNull();
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "edit-options")).toBe(false);
});

it("promotes the latest fresh history revision to the current baseline without relisting namespaces", async () => {
  const current = { ...release, revision: 3, status: "failed" };
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `replicas: ${request.revision}` } }
        : request.operation === "history"
          ? { ...listing, releases: [current, { ...release, revision: 1, status: "superseded" }] }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 3");
  fireEvent.click(screen.getAllByRole("button", { name: "View revision" })[0]);
  await screen.findByText("replicas: 3");
  expect(screen.queryByText("Historical revision · Read only")).toBeNull();
  expect(screen.getByText("Edit values")).toBeTruthy();
  expect(screen.getByText("Revision 3")).toBeTruthy();
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 1");
  fireEvent.click(screen.getAllByRole("button", { name: "View revision" })[1]);
  await screen.findByText("replicas: 1");
  expect(screen.getByText("Historical revision · Read only")).toBeTruthy();
  expect(screen.getByText("Superseded")).toBeTruthy();
  fireEvent.click(screen.getByText("Compare with current"));
  await screen.findByLabelText("Revision comparison");
  expect(screen.getByText("Latest · Revision 3")).toBeTruthy();
  const details = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details");
  expect(details.at(-1)?.[1]).toMatchObject({ revision: 3, section: "values" });
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "list")).toHaveLength(1);
});

it("keeps invalid value drafts editable and requires a new review after definite prelaunch rejection", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "replicas: 2" } }
        : request.operation === "edit-options"
          ? { ok: true, upgradeAllowed: true, chartChoices: [{ ref: "sample/chart", version: "1.0.0" }] }
          : request.operation === "upgrade-values"
            ? { ok: false, error: { code: "invalid-values", message: "Values rejected before launch" } }
            : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("Values"));
  fireEvent.click(await screen.findByText("Edit values"));
  await screen.findByLabelText("Chart source");
  const input = screen.getByLabelText("Edit current release values");
  fireEvent.change(input, { target: { value: "replicas: [" } });
  await screen.findByText(/Values must be a valid YAML mapping/);
  expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "- replicas" } });
  await screen.findByText(/Values must be a valid YAML mapping/);
  expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(true);
  const rejectedDraft = "replicas: &count 3\nworkers: *count";
  fireEvent.change(input, { target: { value: rejectedDraft } });
  expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Review changes"));
  expect(mocks.confirm).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Review changes"));
  await act(async () => mocks.confirm.mock.calls[0][0].ok());
  await screen.findByText("Values rejected before launch");
  const retained = screen.getByLabelText("Edit current release values") as HTMLTextAreaElement;
  expect(retained.value).toBe(rejectedDraft);
  expect(screen.queryByText("Refresh release")).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(1);
  fireEvent.change(retained, { target: { value: "replicas: 4" } });
  await waitFor(() => expect((screen.getByText("Review changes") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Review changes"));
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(1);
  await act(async () => mocks.confirm.mock.calls[1][0].ok());
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "upgrade-values")).toHaveLength(2);
});

it("drops selected metadata across successful context changes before opening another release", async () => {
  const first = { ...listing, releases: [{ ...release, revision: 10 }] };
  let current = first;
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `Context ${request.contextId} revision ${request.revision}` } }
        : current,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  await screen.findByLabelText("Release sample-release");
  current = { ...listing, contextId: "b".repeat(64), releases: [{ ...release, revision: 1 }] };
  fireEvent.click(screen.getAllByText("Refresh")[0]);
  await waitFor(() => expect(screen.queryByLabelText("Release sample-release")).toBeNull());
  expect(screen.getByText("1")).toBeTruthy();
  expect(
    mocks.invoke.mock.calls.some(
      ([, request]) => request.operation === "details" && request.contextId === current.contextId,
    ),
  ).toBe(false);
  current = first;
  fireEvent.click(screen.getByText("Refresh"));
  await screen.findByText("10");
  expect(screen.queryByLabelText("Release sample-release")).toBeNull();
});

it("uses a later successful list as authoritative after a same-context release reinstall", async () => {
  let current = listing;
  let historyVersion = 10;
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `replicas: ${request.revision}` } }
        : request.operation === "history"
          ? { ...listing, releases: [{ ...release, revision: historyVersion }] }
          : current,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 10");
  current = { ...listing, releases: [{ ...release, revision: 1 }] };
  historyVersion = 1;
  fireEvent.click(screen.getAllByText("Refresh")[0]);
  await screen.findByText("Revision 1");
  expect(screen.queryByText("Revision 10")).toBeNull();
  fireEvent.click(screen.getByText("Values"));
  await screen.findByText("replicas: 1");
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details").at(-1)?.[1]).toMatchObject({
    revision: 1,
    contextId: listing.contextId,
  });
});

it("cancels a pending history promotion when a newer successful list supersedes its source metadata", async () => {
  const oldHistory = deferred();
  let current = listing;
  let historyCalls = 0;
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "history" && ++historyCalls === 1
      ? oldHistory.promise
      : Promise.resolve(
          request.operation === "details"
            ? { ok: true, detail: { content: `replicas: ${request.revision}` } }
            : current,
        ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await waitFor(() => expect(historyCalls).toBe(1));
  current = { ...listing, releases: [{ ...release, revision: 1 }] };
  fireEvent.click(screen.getAllByText("Refresh")[0]);
  await screen.findByLabelText("Revision 1");
  expect(historyCalls).toBe(2);
  await act(async () => oldHistory.resolve({ ...listing, releases: [{ ...release, revision: 10 }] }));
  expect(screen.queryByText("Revision 10")).toBeNull();
  expect(screen.queryByLabelText("Revision 10")).toBeNull();
  expect(screen.getByText("Revision 1")).toBeTruthy();
});

it("dismisses the release drawer with Escape, preserves native dialogs and restores the release opener focus", async () => {
  render(<PowerHelmPage />);
  const opener = await screen.findByRole("button", { name: "sample-release" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByLabelText("Release sample-release");
  const dialog = document.createElement("div");
  dialog.dataset.testid = "confirmation-dialog";
  document.body.append(dialog);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByLabelText("Release sample-release")).toBeTruthy();
  dialog.remove();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByLabelText("Release sample-release")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("includes known application versions in unified release search", async () => {
  mocks.appVersions[release.name] = "2.7-demo";
  mocks.invoke.mockResolvedValue(listing);
  render(<PowerHelmPage />);
  await screen.findByText("sample-release");
  fireEvent.change(screen.getByLabelText("Search releases"), { target: { value: "2.7-demo" } });
  expect(screen.getByText("sample-release")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search releases"), { target: { value: "not-this-version" } });
  expect(screen.queryByText("sample-release")).toBeNull();
});

it("searches application versions in revision history without stripping text", async () => {
  mocks.appVersions[release.name] = "2.7-demo";
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "history" ? { ...listing, releases: [{ ...release, revision: 1 }, release] } : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 1");
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "2.7-demo" } });
  expect(screen.getByLabelText("Revision 1")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "missing-version" } });
  expect(screen.queryByLabelText("Revision 1")).toBeNull();
  expect(screen.getByText("No matching revisions")).toBeTruthy();
});

it.each([
  { errors: 1, truncated: false },
  { errors: 0, truncated: true },
])("keeps version search results incomplete after failures or truncation: %j", async (partial) => {
  mocks.indexState = { completed: 1, total: 1, ...partial };
  mocks.invoke.mockResolvedValue(listing);
  render(<PowerHelmPage />);
  await screen.findByText("sample-release");
  fireEvent.change(screen.getByLabelText("Search releases"), { target: { value: "unavailable-version" } });
  expect(screen.getByText("No known matches")).toBeTruthy();
  expect(screen.queryByText("No releases found")).toBeNull();
  expect(screen.getByText("Refresh versions")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search releases"), { target: { value: "" } });
  fireEvent.click(screen.getByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  await screen.findByLabelText("Revision 2");
  fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "unavailable-version" } });
  expect(screen.getByText("No known matches yet")).toBeTruthy();
  expect(screen.queryByText("No matching revisions")).toBeNull();
  expect(screen.getByText("Refresh versions")).toBeTruthy();
});

it("shows chart name and version separately without raw or duplicate metadata fields", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? {
            ok: true,
            detail: {
              content: "",
              overview: {
                name: release.name,
                namespace: release.namespace,
                revision: release.revision,
                status: release.status,
                chart: "demo-chart-1.2.3",
                chartName: "demo-chart",
                chartVersion: "1.2.3",
                appVersion: "4.5",
                description: "A sample release",
                updatedAt: "2026-01-01T12:00:00Z",
              },
            },
          }
        : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  await screen.findByText("demo-chart");
  expect(screen.queryByText("demo-chart-1.2.3")).toBeNull();
  expect(screen.queryByText("chartName")).toBeNull();
  expect(screen.getByText("Chart version")).toBeTruthy();
  expect(screen.getByText("1.2.3")).toBeTruthy();
  expect(screen.getByText("A sample release")).toBeTruthy();
  const listReads = mocks.invoke.mock.calls.filter(([, request]) => request.operation === "list").length;
  fireEvent.click(screen.getByRole("button", { name: "Refresh overview" }));
  await waitFor(() =>
    expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "details")).toHaveLength(2),
  );
  expect(mocks.invoke.mock.calls.filter(([, request]) => request.operation === "list")).toHaveLength(listReads);
});

it("uses inspection-only history in read-only mode and clears old rollback consent before controls return", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `replicas: ${request.revision}` } }
        : request.operation === "history"
          ? { ...listing, releases: [release, { ...release, revision: 1 }], rollbackAllowed: true }
          : listing,
    ),
  );
  const preferences = observable({ enabled: false });
  mocks.readOnlyStore = preferences;
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByText("sample-release"));
  fireEvent.click(screen.getByText("History"));
  fireEvent.click(await screen.findByRole("radio", { name: "Revision 1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /to Revision 1/ }));
  expect((screen.getByText("Roll back") as HTMLButtonElement).disabled).toBe(false);
  act(() =>
    runInAction(() => {
      preferences.enabled = true;
    }),
  );
  await waitFor(() => expect(screen.queryAllByRole("radio")).toHaveLength(0));
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText("Roll back")).toBeNull();
  expect(screen.getByText("Read only")).toBeTruthy();
  act(() =>
    runInAction(() => {
      preferences.enabled = false;
    }),
  );
  await screen.findByRole("radio", { name: "Revision 1" });
  expect((screen.getByRole("radio", { name: "Revision 1" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByText("Roll back") as HTMLButtonElement).disabled).toBe(true);
  act(() =>
    runInAction(() => {
      preferences.enabled = true;
    }),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "View revision" })[1]);
  await screen.findByText("replicas: 1");
  expect(screen.queryByText("Edit values")).toBeNull();
  fireEvent.click(screen.getByText("Compare with current"));
  await screen.findByLabelText("Revision comparison");
  expect(
    mocks.invoke.mock.calls.some(
      ([, request]) => request.operation === "rollback" || request.operation === "upgrade-values",
    ),
  ).toBe(false);
});

it("names an empty namespace without implying all namespaces are one namespace", async () => {
  mocks.invoke.mockResolvedValue({ ok: true, contextId: "empty-context", releases: [] });
  render(<PowerHelmPage />);
  await screen.findByText("No Helm releases in the available namespaces");
  fireEvent.change(screen.getByLabelText("Helm namespace"), { target: { value: "sample" } });
  await screen.findByText("No Helm releases in sample");
});

it("returns to the selected later page after clearing an all-matching version filter", async () => {
  const revisions = Array.from({ length: 250 }, (_, index) => ({
    ...release,
    revision: 250 - index,
    uid: `sample-secret-uid-${250 - index}`,
  }));
  mocks.appVersions[release.name] = "2.7";
  mocks.indexState = { completed: 250, total: 250, errors: 0, truncated: false };
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "history"
        ? { ...listing, releases: revisions, rollbackAllowed: true }
        : request.operation === "details"
          ? { ok: true, detail: { content: "Overview" } }
          : { ...listing, releases: [revisions[0]] },
    ),
  );
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    render(<PowerHelmPage />);
    fireEvent.click(await screen.findByRole("button", { name: release.name }));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await screen.findByLabelText("Revision 250");
    fireEvent.click(screen.getByLabelText("Next revisions"));
    fireEvent.click(screen.getByLabelText("Next revisions"));
    fireEvent.click(screen.getByRole("radio", { name: "Revision 125" }));
    fireEvent.change(screen.getByLabelText("Search revision history"), { target: { value: "2.7" } });
    await screen.findByText("Page 1 / 5");
    fireEvent.click(screen.getByLabelText("Next revisions"));
    fireEvent.click(screen.getByLabelText("Next revisions"));
    fireEvent.click(screen.getByRole("button", { name: "Show selected revision" }));
    await screen.findByText("Page 3 / 5");
    const selected = screen.getByRole("radio", { name: "Revision 125" }) as HTMLInputElement;
    expect(selected.checked).toBe(true);
    expect(document.activeElement).toBe(selected);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "rollback")).toBe(false);
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
}, 15_000);

it("restarts copy feedback for each successful copy", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(request.operation === "details" ? { ok: true, detail: { content: "replicas: 2" } } : listing),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByRole("button", { name: release.name }));
  fireEvent.click(screen.getByRole("tab", { name: "Values" }));
  await screen.findByText("replicas: 2");
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Copy", exact: true }));
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy again", exact: true }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Copied")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1850);
    });
    expect(screen.queryByText("Copied")).toBeNull();
    expect(mocks.copy.mock.calls).toEqual([["replicas: 2"], ["replicas: 2"]]);
  } finally {
    vi.useRealTimers();
  }
});

it("opens releases from ordinary row cells while preserving independent actions and modified clicks", async () => {
  render(<PowerHelmPage />);
  const opener = await screen.findByRole("button", { name: "sample-release" });
  const row = opener.closest("tr")!;
  const revision = row.cells[4];
  fireEvent.click(screen.getByRole("button", { name: "Retry app version" }));
  expect(screen.queryByLabelText("Release sample-release")).toBeNull();
  fireEvent.click(revision, { ctrlKey: true });
  expect(screen.queryByLabelText("Release sample-release")).toBeNull();
  const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected text" } as Selection);
  fireEvent.click(revision);
  expect(screen.queryByLabelText("Release sample-release")).toBeNull();
  selection.mockRestore();
  fireEvent.click(revision);
  await screen.findByLabelText("Release sample-release");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.activeElement).toBe(opener);
});

it("returns from historical values and direct comparisons to history with Escape", async () => {
  const historical = { ...release, revision: 1, uid: "sample-secret-uid-1", status: "failed" };
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `revision: ${request.revision}` } }
        : request.operation === "history"
          ? { ...listing, releases: [release, historical], rollbackAllowed: true }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByRole("button", { name: "sample-release" }));
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  const revision = await screen.findByLabelText("Revision 1");
  fireEvent.click(revision.closest("tr")!.querySelector('[aria-label="View revision"]')!);
  await screen.findByText("revision: 1");
  fireEvent.keyDown(document, { key: "Escape" });
  await screen.findByLabelText("Revision 1");
  expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Compare revision 1" }));
  await screen.findByLabelText("Revision comparison");
  fireEvent.keyDown(document, { key: "Escape" });
  await screen.findByLabelText("Revision 1");
  expect(screen.getByLabelText("Release sample-release")).toBeTruthy();
});

it("restores the viewed comparison source through the guarded full-release rollback flow", async () => {
  const source = { ...release, revision: 1, uid: "sample-secret-uid-1", status: "superseded" };
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: `revision: ${request.revision}` } }
        : request.operation === "history"
          ? { ...listing, releases: [release, source], rollbackAllowed: true }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByRole("button", { name: "sample-release" }));
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: "Compare revision 1" }));
  const restore = await screen.findByRole("button", { name: "Restore revision" });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "history" && request.refresh)).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm rolling back sample-release to Revision 1/ }));
  fireEvent.click(restore);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.confirm.mock.calls[0][0].labelOk).toBe("Restore revision 1");
  expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "rollback")).toBe(false);
  await act(async () => mocks.confirm.mock.calls[0][0].ok());
  expect(mocks.invoke.mock.calls.find(([, request]) => request.operation === "rollback")?.[1]).toMatchObject({
    revision: 1,
    uid: source.uid,
    contextId: listing.contextId,
    confirmed: true,
  });
});

it("does not offer comparison restore for read-only mode or a replaced source identity", async () => {
  mocks.readOnlyStore = observable({ enabled: false });
  const source = { ...release, revision: 1, uid: "sample-secret-uid-1" };
  let changed = false;
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "revision: 1" } }
        : request.operation === "history"
          ? {
              ...listing,
              releases: [release, { ...source, uid: changed ? "replacement-uid" : source.uid }],
              rollbackAllowed: true,
            }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByRole("button", { name: "sample-release" }));
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  await screen.findByRole("button", { name: "Compare revision 1" });
  changed = true;
  fireEvent.click(screen.getByRole("button", { name: "Compare revision 1" }));
  const restore = await screen.findByRole("button", { name: "Restore revision" });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/no longer available to restore/)).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  act(() =>
    runInAction(() => {
      mocks.readOnlyStore!.enabled = true;
    }),
  );
  expect(screen.queryByRole("button", { name: "Restore revision" })).toBeNull();
});

it("keeps current revision comparisons current when returning to the revision", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    Promise.resolve(
      request.operation === "details"
        ? { ok: true, detail: { content: "replicas: 2" } }
        : request.operation === "history"
          ? { ...listing, releases: [release], rollbackAllowed: true }
          : listing,
    ),
  );
  render(<PowerHelmPage />);
  fireEvent.click(await screen.findByRole("button", { name: "sample-release" }));
  fireEvent.click(screen.getByRole("tab", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: "Compare revision 2" }));
  await screen.findByLabelText("Revision comparison");
  expect(screen.queryByText("Historical revision · Read only")).toBeNull();
  expect(screen.queryByRole("button", { name: "Restore revision" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show revision" }));
  await screen.findByRole("button", { name: "Edit values" });
  expect(screen.queryByLabelText("Revision comparison")).toBeNull();
});
