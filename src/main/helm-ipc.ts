import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
import { ipcMain } from "electron";
import { reaction } from "mobx";
import {
  HELM_CHANNEL,
  HELM_INSTALLED_CHART,
  type HelmOperation,
  type HelmRequest,
  type HelmResponse,
} from "../common/helm";
import { HelmPreferencesStore } from "../common/store/helm-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { HelmError, HelmLimiter, HelmService, latestReleases } from "./helm";
import { installedChartFiles, withInstalledChart } from "./helm-installed-chart";
import { chartChoices, validateHelmValues, withHelmValues } from "./helm-values";
import { trustedSearchSender } from "./resource-search";

const reads = new HelmLimiter(2);
const background = new HelmLimiter(1);
const writes = new HelmLimiter(2);
const processes = new HelmLimiter(2);
const nameValid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(v);
export function validateHelmRequest(value: unknown): HelmRequest {
  const r = value as HelmRequest;
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.requestId !== "string" ||
    !/^[\w-]{1,128}$/.test(r.requestId) ||
    !nameValid(r.clusterId) ||
    (r.namespace !== "" && !nameValid(r.namespace)) ||
    ![
      "operations",
      "list",
      "history",
      "details",
      "rollback",
      "edit-options",
      "upgrade-values",
      "uninstall",
      "delete-revision",
      "app-version",
      "cancel",
    ].includes(r.operation)
  )
    throw new HelmError("invalid-request", "Invalid Helm request");
  if (r.contextId !== undefined && (typeof r.contextId !== "string" || !/^[a-f0-9]{64}$/.test(r.contextId)))
    throw new HelmError("invalid-request", "Invalid Helm context");
  if (
    [
      "history",
      "details",
      "rollback",
      "edit-options",
      "upgrade-values",
      "uninstall",
      "delete-revision",
      "app-version",
    ].includes(r.operation) &&
    (!nameValid(r.name) || !r.namespace)
  )
    throw new HelmError("invalid-request", "Select a release namespace and name");
  if (
    ["details", "rollback", "edit-options", "upgrade-values", "uninstall", "delete-revision", "app-version"].includes(
      r.operation,
    ) &&
    (!Number.isSafeInteger(r.revision) || r.revision! < 1)
  )
    throw new HelmError("invalid-request", "Invalid Helm revision");
  if (r.operation === "details" && !["overview", "values", "manifest", "notes"].includes(r.section!))
    throw new HelmError("invalid-request", "Invalid Helm section");
  if (r.uid !== undefined && (typeof r.uid !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(r.uid)))
    throw new HelmError("invalid-request", "Invalid Helm release identity");
  if (["rollback", "upgrade-values", "uninstall", "delete-revision"].includes(r.operation) && typeof r.uid !== "string")
    throw new HelmError("invalid-request", "Refresh releases before changing Helm releases");
  if (r.operation === "upgrade-values") {
    if (typeof r.values !== "string" || Buffer.byteLength(r.values) > 1024 * 1024)
      throw new HelmError("invalid-values", "Values must be YAML text within 1 MiB");
    if (
      typeof r.chart !== "string" ||
      (r.chart !== HELM_INSTALLED_CHART && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(r.chart))
    )
      throw new HelmError("invalid-request", "Select a registered Helm repository chart");
  }
  return r;
}
export function executeHelmRead(
  binary: string,
  args: string[],
  signal: AbortSignal,
  beforeStart: () => void | Promise<void> = () => {},
  launchGuard: () => void = () => {},
): Promise<string> {
  return processes.run(signal, async () => {
    await beforeStart();
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(new HelmError("cancelled", "Helm request cancelled"));
      launchGuard();
      const child = execFile(
        binary,
        args,
        {
          env: { ...process.env },
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) return reject(new HelmError("cancelled", "Helm repository search cancelled"));
          if (!error) return resolve(String(stdout));
          const diagnostic = String(stderr ?? "").slice(0, 4096);
          const message = /no repositories (?:found|configured)/i.test(diagnostic)
            ? "No Helm repositories are configured. Add the chart repository in Helm settings, then refresh chart sources"
            : /no cached repo found|failed to load.*index|index\.yaml.*no such file/i.test(diagnostic)
              ? "Helm repository indexes are unavailable. Refresh repositories in Helm settings, then retry"
              : error.killed
                ? "Helm repository search timed out. Check the local repository configuration and retry"
                : error.code === "ENOENT"
                  ? "The Freelens Helm executable is unavailable. Check the Freelens installation and retry"
                  : "Could not search registered Helm repositories. Check repository configuration and cached indexes in Helm settings";
          reject(new HelmError("chart-unavailable", message));
        },
      );
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  });
}
export function executeHelmRollback(
  binary: string,
  args: string[],
  signal: AbortSignal,
  operation: "rollback" | "upgrade" | "uninstall" = "rollback",
  beforeStart: () => void | Promise<void> = () => {},
  launchGuard: () => void = () => {},
  progress: (phase: "preparing" | "applying" | "waiting", message: string) => void = () => {},
): Promise<void> {
  return processes.run(signal, async () => {
    await beforeStart();
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new HelmError("cancelled", "Helm request cancelled"));
      launchGuard();
      const child = execFile(
        binary,
        args,
        {
          env: { ...process.env },
          // allow Helm to report readiness before the outer process deadline
          timeout: operation === "rollback" ? 330_000 : 75_000,
          maxBuffer: 8 * 1024 * 1024,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          signal.removeEventListener("abort", abort);
          if (!error && !signal.aborted) return resolve();
          if (error && ["ENOENT", "EACCES", "ENOEXEC"].includes(String(error.code))) {
            reject(
              new HelmError(
                "helm-unavailable",
                error.code === "ENOENT"
                  ? "The Freelens Helm executable or one of its required programs is unavailable. Check the Freelens installation and Kubernetes credential plugin, then retry"
                  : "The Freelens Helm executable could not start. Check its permissions and compatibility, then retry",
              ),
            );
            return;
          }
          const diagnostic = String(stderr ?? "").slice(0, 16 * 1024);
          const hint = signal.aborted
            ? "The Helm command was cancelled or exceeded the request time limit"
            : error?.killed
              ? "The Helm command exceeded its time limit"
              : /forbidden|cannot (?:get|list|create|update|patch|delete).*resource/i.test(diagnostic)
                ? "Kubernetes denied access. Check permissions for release Secrets and managed resources"
                : /unauthorized|authentication required|provide credentials|getting credentials|credential plugin|exec: executable/i.test(
                      diagnostic,
                    )
                  ? "Kubernetes authentication failed. Refresh cluster credentials and check the credential plugin"
                  : /x509:|tls handshake|certificate/i.test(diagnostic)
                    ? "Kubernetes TLS verification failed. Check the cluster certificate and kubeconfig"
                    : /connection refused|no such host|dial tcp|network is unreachable|i\/o timeout|context deadline exceeded/i.test(
                          diagnostic,
                        )
                      ? "The Kubernetes API could not be reached. Check the cluster connection and credentials"
                      : /conflict|field manager|fieldmanager/i.test(diagnostic)
                        ? "Kubernetes reported a resource conflict. Review the resource state and field ownership"
                        : /hook|timed out waiting|deadline exceeded/i.test(diagnostic)
                          ? "A Helm hook or resource operation failed or timed out. Review release events and hook Jobs"
                          : /unknown flag|unknown command|incompatible|unsupported/i.test(diagnostic)
                            ? "The Helm command is incompatible with this Helm version. Check the Freelens Helm installation"
                            : "The Helm command failed. Review release history and Kubernetes events for details";
          const label = operation === "upgrade" ? "Upgrade" : operation === "uninstall" ? "Uninstall" : "Rollback";
          reject(
            new HelmError(
              `${operation}-unknown`,
              `${hint}. ${label} outcome is unknown; refresh release history before retrying`,
            ),
          );
        },
      );
      // retain only fixed stage messages, never raw Helm output or resource values
      const buffers = { stdout: "", stderr: "" };
      const consume = (stream: keyof typeof buffers, chunk: Buffer | string) => {
        const lines = (buffers[stream] + String(chunk)).split("\n");
        buffers[stream] = lines.pop()!.slice(-2048);
        for (const line of lines) {
          if (!/\[debug\]|(?:^|\s)level=DEBUG\b/i.test(line)) continue;
          if (/preparing rollback|rolling back/i.test(line)) progress("preparing", "Helm is preparing the rollback");
          else if (/waiting for|beginning wait/i.test(line))
            progress("waiting", "Helm is waiting for resources to become ready");
          else if (
            /performing rollback|creating rolled back release|checking .*resources for changes|updating the status|Patch .* in namespace|Created a new /i.test(
              line,
            )
          )
            progress("applying", "Helm is applying release changes");
        }
      };
      child.stdout?.on("data", (chunk) => consume("stdout", chunk));
      child.stderr?.on("data", (chunk) => consume("stderr", chunk));
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  });
}
function snapshotOperation(record: HelmOperation): HelmOperation {
  return {
    ...record,
    logs: record.logs.map((log) => ({ ...log })),
    error: record.error ? { ...record.error } : undefined,
    stages: record.stages
      ? Object.fromEntries(Object.entries(record.stages).map(([phase, timing]) => [phase, { ...timing }]))
      : undefined,
  };
}
function finishStage(record: HelmOperation, at: number) {
  const phase = record.phase;
  if (phase !== "preparing" && phase !== "applying" && phase !== "waiting") return;
  const stage = record.stages?.[phase];
  if (stage && stage.finishedAt === undefined) stage.finishedAt = at;
}
export function startPowerHelm(): () => void {
  let active = true;
  const helm = HelmPreferencesStore.getInstanceOrCreate<HelmPreferencesStore>();
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const readOnly = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  const pending = new Map<string, AbortController>();
  const operations = new Map<string, HelmOperation>();
  const detached = new Set<string>();
  const reservations = new Map<string, string>();
  const appendLog = (record: HelmOperation, message: string) => {
    if (record.logs.at(-1)?.message === message) return;
    record.logs.push({ at: Date.now(), message });
    if (record.logs.length > 100) record.logs.splice(0, record.logs.length - 100);
  };
  const prune = () => {
    const terminal = [...operations.values()]
      .filter((record) => record.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
    for (const record of terminal.slice(0, Math.max(0, terminal.length - 50))) operations.delete(record.id);
  };
  const services = new Map<string, HelmService>();
  const clusterContexts = new Map<string, string>();
  const uncertain = new Map<string, symbol>();
  const mutations = new Map<string, HelmLimiter>();
  const observed = new Map<Electron.WebContents, () => void>();
  const clear = () => {
    for (const c of pending.values()) c.abort();
    pending.clear();
    for (const s of services.values()) s.clear();
    services.clear();
    clusterContexts.clear();
  };
  const stop = reaction(
    () => power.enabled && helm.enabled,
    (enabled) => {
      if (!enabled) clear();
    },
  );
  const fingerprint = (id: string) => {
    const cluster = Main.Catalog.getClusterById(id);
    if (!cluster) throw new HelmError("unavailable", "Helm cluster unavailable");
    return createHash("sha256")
      .update(id)
      .update("\0")
      .update(cluster.contextName)
      .update("\0")
      .update(cluster.kubeConfigPath)
      .update("\0")
      .update(readFileSync(cluster.kubeConfigPath))
      .digest("hex");
  };
  ipcMain.handle(HELM_CHANNEL, async (event, input): Promise<HelmResponse> => {
    let key: string | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let record: HelmOperation | undefined;
    let reserved: string | undefined;
    try {
      const r = validateHelmRequest(input);
      if (!active || !power.enabled || !helm.enabled || !trustedSearchSender(event, r.clusterId))
        throw new HelmError("unavailable", "Helm is unavailable");
      const frame = event.senderFrame!;
      const owner = `${event.sender.id}:${frame.processId}:${frame.routingId}:`;
      key = `${owner}${r.requestId}`;
      if (r.operation === "cancel") {
        if (!detached.has(key)) pending.get(key)?.abort();
        return { ok: true };
      }
      if (!observed.has(event.sender)) {
        const sender = event.sender;
        const abort = () => {
          for (const [k, c] of pending) if (k.startsWith(`${sender.id}:`) && !detached.has(k)) c.abort();
          for (const s of services.values()) s.clear();
        };
        sender.on("destroyed", abort);
        sender.on("did-start-navigation", abort);
        observed.set(sender, () => {
          sender.removeListener("destroyed", abort);
          sender.removeListener("did-start-navigation", abort);
        });
      }
      const context = fingerprint(r.clusterId);
      const previousContext = clusterContexts.get(r.clusterId);
      if (previousContext && previousContext !== context) {
        services.get(previousContext)?.clear();
        services.delete(previousContext);
      }
      clusterContexts.set(r.clusterId, context);
      if (
        (r.contextId !== undefined && r.contextId !== context) ||
        (["rollback", "upgrade-values", "uninstall", "delete-revision", "edit-options", "app-version"].includes(
          r.operation,
        ) &&
          r.contextId !== context)
      )
        throw new HelmError("context-changed", "Helm context changed; refresh release history before rollback");
      const cluster = Main.Catalog.getClusterById(r.clusterId)!;
      const check = () => {
        if (
          !active ||
          !power.enabled ||
          !helm.enabled ||
          (!record && !trustedSearchSender(event, r.clusterId)) ||
          fingerprint(r.clusterId) !== context
        )
          throw new HelmError("context-changed", "Helm context changed; refresh releases");
      };
      if (r.operation === "operations") {
        return {
          ok: true,
          contextId: context,
          operations: [...operations.values()]
            .filter((entry) => entry.clusterId === r.clusterId && entry.contextId === context)
            .map(snapshotOperation),
        };
      }
      if (pending.has(key))
        throw new HelmError("operation-running", "A Helm request with this identity is already running");
      const releaseKey = `${context}\0${r.namespace}\0${r.name}`;
      if (["rollback", "upgrade-values", "uninstall", "delete-revision"].includes(r.operation)) {
        if (reservations.has(releaseKey))
          throw new HelmError("operation-running", "A Helm operation is already running for this release");
        reservations.set(releaseKey, key);
        reserved = releaseKey;
      }
      if (r.operation === "rollback") {
        if (r.confirmed !== true || readOnly.enabled)
          throw new HelmError("read-only", "Disable read-only mode and explicitly confirm rollback");
        record = {
          id: createHash("sha256").update(key).digest("hex"),
          requestId: r.requestId,
          clusterId: r.clusterId,
          contextId: context,
          namespace: r.namespace,
          name: r.name!,
          revision: r.revision!,
          status: "running",
          phase: "preparing",
          startedAt: Date.now(),
          logs: [],
        };
        record.stages = { preparing: { startedAt: record.startedAt } };
        operations.set(record.id, record);
        appendLog(record, "Preparing rollback and checking release identity");
        detached.add(key);
      }

      controller = new AbortController();
      pending.set(key, controller);
      const signal = controller.signal;
      timer = setTimeout(
        () => controller?.abort(),
        r.operation === "rollback"
          ? 360_000
          : ["upgrade-values", "uninstall", "edit-options"].includes(r.operation)
            ? 90_000
            : 30_000,
      );
      let service = r.operation === "rollback" ? undefined : services.get(context);
      if (!service) {
        service = new HelmService((path, query, metadata, requestSignal) =>
          reads.run(requestSignal, async () => {
            if (!active || !power.enabled || !helm.enabled || fingerprint(r.clusterId) !== context)
              throw new HelmError("context-changed", "Helm context changed; refresh releases");
            const api = Main.K8sApi.KubeJsonApi.forCluster.call(undefined, r.clusterId);
            const response = await api.getResponse(
              path,
              { query },
              {
                signal: requestSignal,
                headers: {
                  Accept: metadata
                    ? "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1"
                    : "application/json",
                },
              },
            );
            if (!response.ok)
              throw new HelmError(
                response.status === 406 ? "metadata-unavailable" : response.status === 403 ? "forbidden" : "api-error",
                response.status === 406
                  ? "The API server does not support metadata-only Helm listing"
                  : response.status === 403
                    ? "Access to Helm release Secrets is forbidden"
                    : "Kubernetes could not load Helm data",
              );
            const length = Number(response.headers.get("content-length") ?? 0);
            if (length > 24 * 1024 * 1024) throw new HelmError("limit", "Helm API response exceeds safety limits");
            const chunks: Buffer[] = [];
            let bytes = 0;
            if (!response.body) throw new HelmError("api-error", "Kubernetes returned an empty response");
            for await (const chunk of response.body) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > 24 * 1024 * 1024) {
                response.body.destroy();
                throw new HelmError("limit", "Helm API response exceeds safety limits");
              }
              chunks.push(buffer);
            }
            const body = Buffer.concat(chunks).toString("utf8");
            if (!active || !power.enabled || !helm.enabled || fingerprint(r.clusterId) !== context)
              throw new HelmError("context-changed", "Helm context changed; refresh releases");
            return JSON.parse(body);
          }),
        );
        if (services.size >= 8) {
          services.values().next().value?.clear();
          services.delete(services.keys().next().value!);
        }
        if (r.operation !== "rollback") services.set(context, service);
      }
      const rollbackAllowed = !readOnly.enabled;
      const binary = () =>
        join(process.resourcesPath, process.arch, process.platform === "win32" ? "helm.exe" : "helm");
      const writeCheck = () => {
        check();
        if (readOnly.enabled) throw new HelmError("read-only", "Disable read-only mode to change Helm releases");
      };
      if (r.operation === "edit-options" && readOnly.enabled)
        return { ok: true, contextId: context, upgradeAllowed: false, chartChoices: [] };
      const mutate = async <T>(action: () => Promise<T>) => {
        let limiter = mutations.get(releaseKey);
        if (!limiter) {
          limiter = new HelmLimiter(1);
          mutations.set(releaseKey, limiter);
        }
        return limiter.run(signal, () => writes.run(signal, action));
      };
      const refreshingOutcome = r.operation === "history" && r.refresh === true ? uncertain.get(releaseKey) : undefined;
      const checkUpgradeOutcome = () => {
        if (uncertain.has(releaseKey))
          throw new HelmError("upgrade-unknown", "Refresh release history before retrying the upgrade");
      };
      if (r.operation === "delete-revision") {
        writeCheck();
        if (r.confirmed !== true)
          throw new HelmError("read-only", "Explicitly confirm deletion of this historical revision");
        await mutate(async () => {
          writeCheck();
          if (uncertain.has(releaseKey))
            throw new HelmError(
              "delete-revision-unknown",
              "Refresh release history before deleting a historical revision",
            );
          const fresh = await service!.list(context, r.namespace, signal, r.name, true, true);
          const target = fresh.rows.find(
            (candidate) =>
              candidate.revision === r.revision &&
              candidate.uid === r.uid &&
              candidate.secretName === `sh.helm.release.v1.${r.name}.v${r.revision}`,
          );
          if (!target || !target.uid || !target.resourceVersion)
            throw new HelmError("stale-revision", "Release revision changed; refresh history before deleting it");
          if (
            latestReleases(fresh.rows)[0]?.revision === target.revision ||
            !["superseded", "failed", "uninstalled"].includes(target.status) ||
            fresh.rows.some((candidate) => candidate.status.startsWith("pending-"))
          )
            throw new HelmError(
              "active-revision",
              "Only inactive historical revisions can be deleted. Keep the current revision and wait for pending release operations to finish",
            );
          writeCheck();
          if (signal.aborted) throw new HelmError("cancelled", "Helm request cancelled");
          let started = false;
          try {
            const api = Main.K8sApi.KubeJsonApi.forCluster.call(undefined, r.clusterId);
            started = true;
            const response = await api.getResponse(
              `/api/v1/namespaces/${encodeURIComponent(target.namespace)}/secrets/${encodeURIComponent(target.secretName)}`,
              {},
              {
                method: "DELETE",
                signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  apiVersion: "v1",
                  kind: "DeleteOptions",
                  propagationPolicy: "Orphan",
                  preconditions: { uid: target.uid, resourceVersion: target.resourceVersion },
                }),
              },
            );
            response.body?.destroy();
            if (response.status === 404 || response.status === 409)
              throw new HelmError("stale-revision", "Release revision changed; refresh history before deleting it");
            if (response.status === 401 || response.status === 403)
              throw new HelmError(
                "forbidden",
                "Kubernetes denied deletion of this Helm history Secret. Check release Secret permissions",
              );
            if (!response.ok) throw new Error("Deletion outcome unavailable");
          } catch (error) {
            if (error instanceof HelmError) throw error;
            if (started) uncertain.set(releaseKey, Symbol());
            throw new HelmError(
              "delete-revision-unknown",
              "The historical revision deletion outcome is unknown; refresh release history before retrying",
            );
          } finally {
            for (const entry of services.values()) entry.clear();
          }
        });
        check();
        return { ok: true, contextId: context };
      }
      if (r.operation === "uninstall") {
        writeCheck();
        if (r.confirmed !== true || r.confirmationName !== r.name)
          throw new HelmError("confirmation-required", "Type the exact release name to confirm uninstall");
        const checkOutcome = () => {
          if (uncertain.has(releaseKey))
            throw new HelmError("uninstall-unknown", "Refresh release history before retrying deletion");
        };
        const beforeStart = async () => {
          writeCheck();
          checkOutcome();
          const fresh = await service!.list(context, r.namespace, signal, r.name, true);
          const current = latestReleases(fresh.rows)[0];
          if (!current || current.revision !== r.revision || current.uid !== r.uid)
            throw new HelmError("stale-revision", "Release changed; refresh history before deleting");
          writeCheck();
          checkOutcome();
        };
        await mutate(async () => {
          try {
            await executeHelmRollback(
              binary(),
              [
                "uninstall",
                r.name!,
                "--namespace",
                r.namespace,
                "--kubeconfig",
                cluster.kubeConfigPath,
                "--kube-context",
                cluster.contextName,
                "--timeout",
                "60s",
              ],
              signal,
              "uninstall",
              beforeStart,
              () => {
                writeCheck();
                checkOutcome();
              },
            );
          } catch (error) {
            if (error instanceof HelmError && error.code === "uninstall-unknown") uncertain.set(releaseKey, Symbol());
            throw error;
          } finally {
            for (const entry of services.values()) entry.clear();
          }
        });
        check();
        return { ok: true, contextId: context };
      }
      if (r.operation === "upgrade-values") {
        checkUpgradeOutcome();
        writeCheck();
        if (r.confirmed !== true) throw new HelmError("read-only", "Explicitly confirm the values upgrade");
        validateHelmValues(r.values);
      }
      const resolveChoices = async (row: import("../common/helm").HelmReleaseMetadata, preferInstalled = true) => {
        const metadata = await service!.chartMetadata(context, row, signal);
        check();
        const detail = await service!.detail(context, row, "overview", signal);
        check();
        if (detail.overview.namespace !== row.namespace)
          throw new HelmError(
            "unsupported-release-namespace",
            "Values editing is unavailable when the release target namespace differs from its storage namespace. Use the release's original deployment tool to edit values",
          );
        try {
          if (!preferInstalled) throw new HelmError("installed-chart-unavailable", "Repository chart requested");
          const stored = await service!.installedChart(context, row, signal);
          check();
          installedChartFiles(stored);
          return { metadata, choices: [{ ref: HELM_INSTALLED_CHART, version: metadata.version }], stored };
        } catch (error) {
          if (!(error instanceof HelmError) || error.code !== "installed-chart-unavailable") throw error;
        }
        const output = await executeHelmRead(
          binary(),
          ["search", "repo", metadata.name, "--version", metadata.version, "--versions", "--output", "json"],
          signal,
          check,
          check,
        ).catch((error) => {
          if (preferInstalled && error instanceof HelmError)
            throw new HelmError(error.code, `The installed chart is incomplete or has dependencies. ${error.message}`);
          throw error;
        });
        check();
        const choices = chartChoices(output, metadata.name, metadata.version);
        if (preferInstalled && choices.length === 0)
          throw new HelmError(
            "chart-unavailable",
            "The installed chart is incomplete or has dependencies, and its exact chart version is unavailable in registered repositories. Configure the original chart repository and refresh chart sources",
          );
        return { metadata, choices };
      };
      if (r.operation === "upgrade-values") {
        await mutate(async () => {
          checkUpgradeOutcome();
          writeCheck();
          const fresh = await service!.list(context, r.namespace, signal, r.name, true);
          const current = latestReleases(fresh.rows)[0];
          if (!current || current.revision !== r.revision || current.uid !== r.uid)
            throw new HelmError("stale-revision", "Release changed; refresh history before editing values");
          const { metadata, choices, stored } = await resolveChoices(current, r.chart === HELM_INSTALLED_CHART);
          if (!choices.some((choice) => choice.ref === r.chart))
            throw new HelmError("chart-unavailable", "Selected chart is unavailable in registered repositories");
          const upgrade = async (chart: string) =>
            withHelmValues(r.values!, async (path) => {
              writeCheck();
              checkUpgradeOutcome();
              try {
                await executeHelmRollback(
                  binary(),
                  [
                    "upgrade",
                    current.name,
                    chart,
                    "--version",
                    metadata.version,
                    "--values",
                    path,
                    "--reset-values",
                    "--history-max",
                    "0",
                    "--namespace",
                    current.namespace,
                    "--kubeconfig",
                    cluster.kubeConfigPath,
                    "--kube-context",
                    cluster.contextName,
                    "--timeout",
                    "60s",
                  ],
                  signal,
                  "upgrade",
                  async () => {
                    writeCheck();
                    checkUpgradeOutcome();
                    const final = await service!.list(context, r.namespace, signal, r.name, true);
                    if (
                      latestReleases(final.rows)[0]?.revision !== r.revision ||
                      latestReleases(final.rows)[0]?.uid !== r.uid
                    )
                      throw new HelmError("stale-revision", "Release changed; refresh history before editing values");
                    writeCheck();
                    checkUpgradeOutcome();
                  },
                  () => {
                    writeCheck();
                    checkUpgradeOutcome();
                  },
                );
              } catch (error) {
                if (error instanceof HelmError && error.code === "upgrade-unknown") uncertain.set(releaseKey, Symbol());
                throw error;
              } finally {
                for (const entry of services.values()) entry.clear();
              }
            });
          if (r.chart === HELM_INSTALLED_CHART) {
            if (!stored)
              throw new HelmError(
                "installed-chart-unavailable",
                "The installed chart is incomplete. Refresh chart sources",
              );
            await withInstalledChart(installedChartFiles(stored), upgrade);
          } else await upgrade(r.chart!);
        });
        check();
        return { ok: true, contextId: context, upgradeAllowed: !readOnly.enabled };
      }
      if (r.operation === "app-version") {
        const row = {
          name: r.name!,
          namespace: r.namespace,
          revision: r.revision!,
          uid: r.uid,
          status: "unknown",
          secretName: `sh.helm.release.v1.${r.name}.v${r.revision}`,
        };
        const summary = await background.run(signal, async () => {
          check();
          return service!.appVersion(context, row, signal, r.refresh === true);
        });
        check();
        return { ok: true, contextId: context, ...summary };
      }
      if (r.operation === "details") {
        const row = {
          name: r.name!,
          namespace: r.namespace,
          revision: r.revision!,
          uid: r.uid,
          status: "unknown",
          secretName: `sh.helm.release.v1.${r.name}.v${r.revision}`,
        };
        const detail = await service.detail(context, row, r.section!, signal, r.refresh === true);
        check();
        return { ok: true, contextId: context, detail, rollbackAllowed, uninstallAllowed: rollbackAllowed };
      }
      const data = await service.list(
        context,
        r.namespace,
        signal,
        r.operation === "list" ? undefined : r.name,
        r.refresh === true,
      );
      check();
      if (refreshingOutcome !== undefined && uncertain.get(releaseKey) === refreshingOutcome)
        uncertain.delete(releaseKey);
      if (r.operation === "list" || r.operation === "history")
        return {
          ok: true,
          contextId: context,
          releases:
            r.operation === "list" ? latestReleases(data.rows) : data.rows.sort((a, b) => b.revision - a.revision),
          fetchedAt: data.fetchedAt,
          cached: data.cached,
          rollbackAllowed,
          uninstallAllowed: rollbackAllowed,
        };
      const row = data.rows.find(
        (row) => row.name === r.name && row.namespace === r.namespace && row.revision === r.revision,
      );
      if (!row) throw new HelmError("not-found", "Helm release revision is no longer available");
      if (r.operation === "edit-options") {
        const current = latestReleases(data.rows)[0];
        if (!current || current.revision !== r.revision)
          throw new HelmError("stale-revision", "Refresh history and select the current revision to edit values");
        const { choices } = await resolveChoices(current);
        check();
        return { ok: true, contextId: context, chartChoices: choices, upgradeAllowed: !readOnly.enabled };
      }
      if (r.operation !== "rollback" || r.confirmed !== true || readOnly.enabled)
        throw new HelmError("read-only", "Disable read-only mode and explicitly confirm rollback");
      const checkRollbackOutcome = () => {
        if (uncertain.has(releaseKey))
          throw new HelmError("rollback-unknown", "Refresh release history before retrying rollback");
      };
      checkRollbackOutcome();
      await mutate(async () => {
        check();
        checkRollbackOutcome();
        if (readOnly.enabled) throw new HelmError("read-only", "Read-only mode blocks rollback");
        try {
          await executeHelmRollback(
            join(process.resourcesPath, process.arch, process.platform === "win32" ? "helm.exe" : "helm"),
            [
              "rollback",
              row.name,
              String(row.revision),
              "--history-max",
              "0",
              "--namespace",
              row.namespace,
              "--kubeconfig",
              cluster.kubeConfigPath,
              "--kube-context",
              cluster.contextName,
              "--debug",
              "--wait",
              "--timeout",
              "5m",
            ],
            signal,
            "rollback",
            async () => {
              writeCheck();
              checkRollbackOutcome();
              const fresh = await service!.list(context, r.namespace, signal, r.name, true);
              const target = fresh.rows.find(
                (candidate) => candidate.revision === r.revision && candidate.uid === r.uid,
              );
              if (!target) throw new HelmError("stale-revision", "Release changed; refresh history before rollback");
              writeCheck();
            },
            () => {
              writeCheck();
              checkRollbackOutcome();
            },
            (phase, message) => {
              if (record) {
                const order = { preparing: 0, applying: 1, waiting: 2, completed: 3, failed: 3 };
                if (order[phase] > order[record.phase]) {
                  const at = Date.now();
                  finishStage(record, at);
                  record.stages ??= {};
                  record.stages[phase] = { startedAt: at };
                  record.phase = phase;
                }
                appendLog(record, message);
              }
            },
          );
        } catch (error) {
          if (error instanceof HelmError && error.code === "rollback-unknown") uncertain.set(releaseKey, Symbol());
          throw error;
        } finally {
          for (const s of services.values()) s.clear();
        }
      });
      check();
      if (record) {
        record.finishedAt = Date.now();
        finishStage(record, record.finishedAt);
        record.status = "succeeded";
        record.phase = "completed";
        appendLog(record, "Rollback completed and resources are ready");
      }
      return {
        ok: true,
        contextId: context,
        rollbackAllowed: !readOnly.enabled,
        operations: record ? [snapshotOperation(record)] : undefined,
      };
    } catch (error) {
      if (record) {
        record.finishedAt = Date.now();
        finishStage(record, record.finishedAt);
        record.status = "failed";
        record.phase = "failed";
        record.error =
          error instanceof HelmError
            ? { code: error.code, message: error.message }
            : { code: "unavailable", message: "Helm rollback is unavailable" };
        appendLog(record, record.error.message);
      }
      return {
        ok: false,
        operations: record ? [snapshotOperation(record)] : undefined,
        error:
          error instanceof HelmError
            ? { code: error.code, message: error.message }
            : {
                code: controller?.signal.aborted ? "cancelled" : "unavailable",
                message: controller?.signal.aborted
                  ? "Helm request cancelled or timed out"
                  : "Helm data is unavailable",
              },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (reserved && reservations.get(reserved) === key) reservations.delete(reserved);
      if (key && record) detached.delete(key);
      prune();
      if (key && pending.get(key) === controller) pending.delete(key);
    }
  });
  return () => {
    active = false;
    stop();
    clear();
    for (const cleanup of observed.values()) cleanup();
    observed.clear();
    ipcMain.removeHandler(HELM_CHANNEL);
  };
}
