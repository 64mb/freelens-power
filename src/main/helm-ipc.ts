import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
import { ipcMain } from "electron";
import { reaction } from "mobx";
import { HELM_CHANNEL, type HelmRequest, type HelmResponse } from "../common/helm";
import { HelmPreferencesStore } from "../common/store/helm-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { HelmError, HelmLimiter, HelmService, latestReleases } from "./helm";
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
    !["list", "history", "details", "rollback", "edit-options", "upgrade-values", "app-version", "cancel"].includes(
      r.operation,
    )
  )
    throw new HelmError("invalid-request", "Invalid Helm request");
  if (r.contextId !== undefined && (typeof r.contextId !== "string" || !/^[a-f0-9]{64}$/.test(r.contextId)))
    throw new HelmError("invalid-request", "Invalid Helm context");
  if (
    ["history", "details", "rollback", "edit-options", "upgrade-values", "app-version"].includes(r.operation) &&
    (!nameValid(r.name) || !r.namespace)
  )
    throw new HelmError("invalid-request", "Select a release namespace and name");
  if (
    ["details", "rollback", "edit-options", "upgrade-values", "app-version"].includes(r.operation) &&
    (!Number.isSafeInteger(r.revision) || r.revision! < 1)
  )
    throw new HelmError("invalid-request", "Invalid Helm revision");
  if (r.operation === "details" && !["overview", "values", "manifest", "notes"].includes(r.section!))
    throw new HelmError("invalid-request", "Invalid Helm section");
  if (r.uid !== undefined && (typeof r.uid !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(r.uid)))
    throw new HelmError("invalid-request", "Invalid Helm release identity");
  if (["rollback", "upgrade-values"].includes(r.operation) && typeof r.uid !== "string")
    throw new HelmError("invalid-request", "Refresh releases before changing Helm releases");
  if (r.operation === "upgrade-values") {
    if (typeof r.values !== "string" || Buffer.byteLength(r.values) > 1024 * 1024)
      throw new HelmError("invalid-values", "Values must be YAML text within 1 MiB");
    if (typeof r.chart !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(r.chart))
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
  operation: "rollback" | "upgrade" = "rollback",
  beforeStart: () => void | Promise<void> = () => {},
  launchGuard: () => void = () => {},
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
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          if (error || signal.aborted)
            reject(
              new HelmError(
                `${operation}-unknown`,
                `${operation === "upgrade" ? "Upgrade" : "Rollback"} outcome is unknown; refresh release history before retrying`,
              ),
            );
          else resolve();
        },
      );
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  });
}
export function startPowerHelm(): () => void {
  let active = true;
  const helm = HelmPreferencesStore.getInstanceOrCreate<HelmPreferencesStore>();
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const readOnly = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  const pending = new Map<string, AbortController>();
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
    try {
      const r = validateHelmRequest(input);
      if (!active || !power.enabled || !helm.enabled || !trustedSearchSender(event, r.clusterId))
        throw new HelmError("unavailable", "Helm is unavailable");
      const frame = event.senderFrame!;
      const owner = `${event.sender.id}:${frame.processId}:${frame.routingId}:`;
      key = `${owner}${r.requestId}`;
      if (r.operation === "cancel") {
        pending.get(key)?.abort();
        return { ok: true };
      }
      if (!observed.has(event.sender)) {
        const sender = event.sender;
        const abort = () => {
          for (const [k, c] of pending) if (k.startsWith(`${sender.id}:`)) c.abort();
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
        (["rollback", "upgrade-values", "edit-options", "app-version"].includes(r.operation) && r.contextId !== context)
      )
        throw new HelmError("context-changed", "Helm context changed; refresh release history before rollback");
      const cluster = Main.Catalog.getClusterById(r.clusterId)!;
      const check = () => {
        if (
          !active ||
          !power.enabled ||
          !helm.enabled ||
          !trustedSearchSender(event, r.clusterId) ||
          fingerprint(r.clusterId) !== context
        )
          throw new HelmError("context-changed", "Helm context changed; refresh releases");
      };
      pending.get(key)?.abort();
      controller = new AbortController();
      pending.set(key, controller);
      const signal = controller.signal;
      timer = setTimeout(
        () => controller?.abort(),
        ["rollback", "upgrade-values", "edit-options"].includes(r.operation) ? 90_000 : 30_000,
      );
      let service = services.get(context);
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
        services.set(context, service);
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
      const releaseKey = `${context}\0${r.namespace}\0${r.name}`;
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
      if (r.operation === "upgrade-values") {
        checkUpgradeOutcome();
        writeCheck();
        if (r.confirmed !== true) throw new HelmError("read-only", "Explicitly confirm the values upgrade");
        validateHelmValues(r.values);
      }
      const resolveChoices = async (row: import("../common/helm").HelmReleaseMetadata) => {
        const metadata = await service!.chartMetadata(context, row, signal);
        check();
        const output = await executeHelmRead(
          binary(),
          ["search", "repo", metadata.name, "--version", metadata.version, "--versions", "--output", "json"],
          signal,
          check,
          check,
        );
        check();
        return { metadata, choices: chartChoices(output, metadata.name, metadata.version) };
      };
      if (r.operation === "upgrade-values") {
        await mutate(async () => {
          checkUpgradeOutcome();
          writeCheck();
          const fresh = await service!.list(context, r.namespace, signal, r.name, true);
          const current = latestReleases(fresh.rows)[0];
          if (!current || current.revision !== r.revision || current.uid !== r.uid)
            throw new HelmError("stale-revision", "Release changed; refresh history before editing values");
          const { metadata, choices } = await resolveChoices(current);
          if (!choices.some((choice) => choice.ref === r.chart))
            throw new HelmError("chart-unavailable", "Selected chart is unavailable in registered repositories");
          await withHelmValues(r.values!, async (path) => {
            writeCheck();
            checkUpgradeOutcome();
            try {
              await executeHelmRollback(
                binary(),
                [
                  "upgrade",
                  current.name,
                  r.chart!,
                  "--version",
                  metadata.version,
                  "--values",
                  path,
                  "--reset-values",
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
        return { ok: true, contextId: context, detail, rollbackAllowed };
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
      await mutate(async () => {
        check();
        if (readOnly.enabled) throw new HelmError("read-only", "Read-only mode blocks rollback");
        try {
          await executeHelmRollback(
            join(process.resourcesPath, process.arch, process.platform === "win32" ? "helm.exe" : "helm"),
            [
              "rollback",
              row.name,
              String(row.revision),
              "--namespace",
              row.namespace,
              "--kubeconfig",
              cluster.kubeConfigPath,
              "--kube-context",
              cluster.contextName,
              "--timeout",
              "60s",
            ],
            signal,
            "rollback",
            async () => {
              writeCheck();
              const fresh = await service!.list(context, r.namespace, signal, r.name, true);
              const target = fresh.rows.find(
                (candidate) => candidate.revision === r.revision && candidate.uid === r.uid,
              );
              if (!target) throw new HelmError("stale-revision", "Release changed; refresh history before rollback");
              writeCheck();
            },
            writeCheck,
          );
        } finally {
          for (const s of services.values()) s.clear();
        }
      });
      check();
      return { ok: true, contextId: context, rollbackAllowed: !readOnly.enabled };
    } catch (error) {
      return {
        ok: false,
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
