import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Common, Main } from "@freelensapp/extensions";
import { reaction } from "mobx";
import {
  NODE_BULK_CHANNEL,
  NODE_BULK_LIMIT,
  type NodeBulkJob,
  type NodeBulkRequest,
  type NodeBulkResponse,
} from "../common/node-bulk";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { powerIpc } from "./power-ipc";
import { trustedSearchSender } from "./resource-search";

export class NodeBulkError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function validateNodeBulkRequest(input: unknown): NodeBulkRequest {
  const r = input as NodeBulkRequest;
  if (
    !r ||
    !["context", "begin", "status", "cancel"].includes(r.operation) ||
    typeof r.clusterId !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(r.clusterId)
  )
    throw new NodeBulkError("invalid-request", "Invalid node operation request");
  if (r.operation !== "context" && (typeof r.contextId !== "string" || !/^[a-f0-9]{64}$/.test(r.contextId)))
    throw new NodeBulkError("invalid-request", "Refresh the node operation context");
  if (["status", "cancel"].includes(r.operation) && (typeof r.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(r.jobId)))
    throw new NodeBulkError("invalid-request", "Invalid node operation identity");
  if (
    r.operation === "begin" &&
    (r.confirmed !== true ||
      !["cordon", "uncordon", "drain"].includes(r.action!) ||
      !Array.isArray(r.nodes) ||
      !r.nodes.length ||
      r.nodes.length > NODE_BULK_LIMIT ||
      r.nodes.some(
        (n) =>
          !n ||
          typeof n.name !== "string" ||
          !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(n.name) ||
          typeof n.uid !== "string" ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(n.uid),
      ) ||
      new Set(r.nodes.map((n) => n.name)).size !== r.nodes.length)
  )
    throw new NodeBulkError("invalid-request", "Confirm a valid selection of up to 100 distinct nodes");
  return r;
}
export function executeNodeKubectl(
  binary: string,
  args: string[],
  signal: AbortSignal,
  guard: () => void,
  environment?: Record<string, string>,
): Promise<string> {
  return Promise.resolve(environment ?? Main.Shell.getEnvironment()).then(
    (env) =>
      new Promise<string>((resolve, reject) => {
        guard();
        if (signal.aborted) return reject(new NodeBulkError("cancelled", "Node operation cancelled"));
        const child = execFile(
          binary,
          args,
          { env, timeout: 330_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL", windowsHide: true },
          (error, stdout) => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted)
              return reject(
                new NodeBulkError("cancelled", "Node operation cancelled; refresh nodes to check the current state"),
              );
            if (error)
              return reject(
                new NodeBulkError(
                  "command-failed",
                  "Node command failed or timed out; refresh nodes and check Kubernetes events before retrying",
                ),
              );
            resolve(String(stdout));
          },
        );
        const abort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
  );
}
export async function runNodeBulkJob(
  job: NodeBulkJob,
  signal: AbortSignal,
  guard: () => void,
  execute: (args: string[]) => Promise<string>,
): Promise<void> {
  for (const node of job.nodes) {
    try {
      guard();
      if (signal.aborted) throw new NodeBulkError("cancelled", "Node operation cancelled");
      node.status = "running";
      const fresh = JSON.parse(await execute(["get", "node", node.name, "--output=json", "--request-timeout=30s"]));
      guard();
      if (signal.aborted) throw new NodeBulkError("cancelled", "Node operation cancelled");
      if (fresh?.metadata?.uid !== node.uid)
        throw new NodeBulkError("node-changed", "Node identity changed; refresh the node list");
      await execute([
        job.action,
        node.name,
        ...(job.action === "drain" ? ["--ignore-daemonsets", "--timeout=5m"] : []),
        "--request-timeout=30s",
      ]);
      node.status = "succeeded";
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof NodeBulkError && error.code === "cancelled");
      node.status = cancelled ? "cancelled" : "failed";
      node.message =
        error instanceof NodeBulkError
          ? error.message
          : "Node operation failed; refresh nodes to check the current state";
      job.status = cancelled ? "cancelled" : "failed";
      break;
    }
  }
  if (job.status === "running") job.status = "succeeded";
  else for (const node of job.nodes) if (node.status === "pending") node.status = "skipped";
  job.finishedAt = Date.now();
}
export function startNodeBulk(): () => void {
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const readOnly = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  let active = true;
  const jobs = new Map<string, { job: NodeBulkJob; owner: string; controller: AbortController }>();
  const fingerprint = (id: string) => {
    const cluster = Main.Catalog.getClusterById(id);
    if (!cluster || cluster.status !== Common.Clusters.ClusterConnectionStatus.CONNECTED)
      throw new NodeBulkError("unavailable", "Cluster unavailable");
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
  const abortAll = () => {
    for (const entry of jobs.values()) entry.controller.abort();
  };
  const stop = reaction(
    () => power.enabled && power.nodeBulkActions !== false && !readOnly.enabled,
    (enabled) => {
      if (!enabled) abortAll();
    },
  );
  powerIpc.handle(NODE_BULK_CHANNEL, async (event, input): Promise<NodeBulkResponse> => {
    let preparationCleanup: (() => void) | undefined;
    try {
      const r = validateNodeBulkRequest(input);
      if (!active || !power.enabled || !trustedSearchSender(event, r.clusterId))
        throw new NodeBulkError("unavailable", "Node operations unavailable");
      const frame = event.senderFrame!;
      const owner = `${event.sender.id}:${frame.processId}:${frame.routingId}`;
      if (r.operation === "status" || r.operation === "cancel") {
        const entry = jobs.get(r.jobId!);
        if (
          !entry ||
          entry.owner !== owner ||
          entry.job.clusterId !== r.clusterId ||
          entry.job.contextId !== r.contextId
        )
          throw new NodeBulkError("unavailable", "Node operation unavailable");
        if (r.operation === "cancel") entry.controller.abort();
        return { ok: true, contextId: entry.job.contextId, job: structuredClone(entry.job) };
      }
      if (power.nodeBulkActions === false)
        throw new NodeBulkError("unavailable", "Bulk node actions are disabled in preferences");
      const context = fingerprint(r.clusterId);
      if (r.operation === "context") return { ok: true, contextId: context };
      if (r.contextId !== context)
        throw new NodeBulkError("context-changed", "Cluster context changed; refresh nodes before retrying");
      if (readOnly.enabled) throw new NodeBulkError("read-only", "Disable read-only mode before changing nodes");
      if ([...jobs.values()].some((e) => e.job.clusterId === r.clusterId && e.job.status === "running"))
        throw new NodeBulkError("operation-running", "A node operation is already running in this cluster");
      for (const [id, entry] of jobs) if (jobs.size >= 50 && entry.job.status !== "running") jobs.delete(id);
      if (jobs.size >= 50) throw new NodeBulkError("operation-running", "Too many node operations are running");
      const controller = new AbortController();
      const job: NodeBulkJob = {
        id: randomUUID(),
        clusterId: r.clusterId,
        contextId: context,
        action: r.action!,
        status: "running",
        nodes: r.nodes!.map((n) => ({ name: n.name, uid: n.uid, status: "pending" })),
        startedAt: Date.now(),
      };
      jobs.set(job.id, { job, owner, controller });
      const stopConnection = reaction(
        () => Main.Catalog.getClusterById(r.clusterId)?.status,
        (status) => {
          if (status !== Common.Clusters.ClusterConnectionStatus.CONNECTED) controller.abort();
        },
        { fireImmediately: true },
      );
      preparationCleanup = () => {
        stopConnection();
        jobs.delete(job.id);
        controller.abort();
      };
      const environment = await Main.Shell.getEnvironment(r.clusterId);
      let snapshotContext: string | undefined;
      let snapshotDirectory: string | undefined;
      let snapshotPath: string | undefined;
      const binary = await Main.Shell.getKubectlPath(r.clusterId);
      const guard = () => {
        try {
          if (
            active &&
            power.enabled &&
            power.nodeBulkActions !== false &&
            !readOnly.enabled &&
            trustedSearchSender(event, r.clusterId) &&
            fingerprint(r.clusterId) === context
          )
            return;
        } catch {
          // unavailable kubeconfig files must stop the job before another command starts
        }
        controller.abort();
        throw new NodeBulkError(
          "cancelled",
          "Node operation stopped because access or cluster context changed; refresh nodes to check the current state",
        );
      };
      const interval = setInterval(() => {
        try {
          guard();
        } catch {
          controller.abort();
        }
      }, 250);
      const abort = () => controller.abort();
      event.sender.on("destroyed", abort);
      event.sender.on("did-start-navigation", abort);
      const execute = async (command: string[]) => {
        if (!snapshotPath) {
          const raw = await executeNodeKubectl(
            binary,
            ["config", "view", "--raw", "--flatten", "--minify", "--output=json"],
            controller.signal,
            guard,
            environment,
          );
          guard();
          if (controller.signal.aborted) throw new NodeBulkError("cancelled", "Node operation cancelled");
          const config = JSON.parse(raw);
          if (
            typeof config?.["current-context"] !== "string" ||
            !config["current-context"] ||
            config?.contexts?.length !== 1 ||
            config.contexts[0]?.name !== config["current-context"]
          )
            throw new NodeBulkError("context-changed", "Cluster context changed; refresh nodes before retrying");
          snapshotContext = config["current-context"];
          for (const entry of config.users ?? []) {
            const exec = entry?.user?.exec;
            if (typeof exec?.command === "string" && /[\\/]/.test(exec.command) && !isAbsolute(exec.command))
              exec.command = resolve(dirname(environment.KUBECONFIG), exec.command);
          }
          snapshotDirectory = mkdtempSync(join(tmpdir(), "freelens-power-node-bulk-"));
          chmodSync(snapshotDirectory, 0o700);
          snapshotPath = join(snapshotDirectory, "config.json");
          writeFileSync(snapshotPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
        }
        return executeNodeKubectl(
          binary,
          ["--kubeconfig", snapshotPath, "--context", snapshotContext!, ...command],
          controller.signal,
          guard,
          environment,
        );
      };
      void runNodeBulkJob(job, controller.signal, guard, execute).finally(() => {
        if (snapshotDirectory) {
          try {
            rmSync(snapshotDirectory, { recursive: true, force: true });
          } catch {
            // cleanup must not expose private kubeconfig contents in operation progress
          }
        }
        stopConnection();
        clearInterval(interval);
        event.sender.removeListener("destroyed", abort);
        event.sender.removeListener("did-start-navigation", abort);
      });
      preparationCleanup = undefined;
      return { ok: true, contextId: context, job: structuredClone(job) };
    } catch (error) {
      preparationCleanup?.();
      return {
        ok: false,
        error:
          error instanceof NodeBulkError
            ? { code: error.code, message: error.message }
            : { code: "unavailable", message: "Node operations unavailable" },
      };
    }
  });
  return () => {
    active = false;
    stop();
    abortAll();
    powerIpc.removeHandler(NODE_BULK_CHANNEL);
  };
}
