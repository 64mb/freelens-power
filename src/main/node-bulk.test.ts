import { EventEmitter } from "node:events";
import { observable, runInAction } from "mobx";
import { beforeEach, expect, it, vi } from "vitest";

import type { NodeBulkJob } from "../common/node-bulk";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  remove: vi.fn(),
  trusted: vi.fn(() => true),
  cluster: vi.fn(),
  exec: vi.fn(),
  config: "neutral",
  mkdir: vi.fn(() => "/neutral/private-job"),
  chmod: vi.fn(),
  write: vi.fn(),
  rm: vi.fn(),
  power: { enabled: true },
  readOnly: { enabled: false },
}));
vi.mock("@freelensapp/extensions", () => ({
  Common: { App: { Preferences: { getKubectlPath: () => "/neutral/kubectl" } } },
  Main: { Catalog: { getClusterById: mocks.cluster } },
}));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.remove } }));
vi.mock("node:fs", () => ({
  readFileSync: () => mocks.config,
  mkdtempSync: mocks.mkdir,
  chmodSync: mocks.chmod,
  writeFileSync: mocks.write,
  rmSync: mocks.rm,
}));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("./resource-search", () => ({ trustedSearchSender: mocks.trusted }));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.power },
}));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => mocks.readOnly },
}));

import { executeNodeKubectl, NodeBulkError, runNodeBulkJob, startNodeBulk, validateNodeBulkRequest } from "./node-bulk";

function job(): NodeBulkJob {
  return {
    id: "job",
    clusterId: "cluster",
    contextId: "a".repeat(64),
    action: "drain",
    status: "running",
    startedAt: 1,
    nodes: [
      { name: "node-a", uid: "uid-a", status: "pending" },
      { name: "node-b", uid: "uid-b", status: "pending" },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.power = observable({ enabled: true });
  mocks.readOnly = observable({ enabled: false });
  mocks.trusted.mockReturnValue(true);
  mocks.cluster.mockReturnValue({ contextName: "neutral", kubeConfigPath: "/neutral/config" });
  mocks.config = "neutral";
});
it("validates node identities, explicit confirmation and the batch bound", () => {
  const request = {
    operation: "begin",
    clusterId: "cluster",
    contextId: "a".repeat(64),
    action: "drain",
    confirmed: true,
    nodes: [{ name: "node-a", uid: "uid-a" }],
  };
  expect(validateNodeBulkRequest(request)).toEqual(request);
  for (const change of [
    { confirmed: false },
    { nodes: [{ name: "--force", uid: "uid" }] },
    { nodes: Array(101).fill(request.nodes[0]) },
    { nodes: [request.nodes[0], request.nodes[0]] },
  ])
    expect(() => validateNodeBulkRequest({ ...request, ...change })).toThrow();
});
it("checks fresh UIDs and stops on first failure, retaining completed results", async () => {
  const record = job();
  const execute = vi
    .fn()
    .mockResolvedValueOnce('{"metadata":{"uid":"uid-a"}}')
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce('{"metadata":{"uid":"replacement"}}');
  await runNodeBulkJob(record, new AbortController().signal, () => {}, execute);
  expect(record.status).toBe("failed");
  expect(record.nodes.map((n) => n.status)).toEqual(["succeeded", "failed"]);
  expect(execute.mock.calls[1][0]).toEqual([
    "drain",
    "node-a",
    "--ignore-daemonsets",
    "--timeout=5m",
    "--request-timeout=30s",
  ]);
  expect(execute).toHaveBeenCalledTimes(3);
});
it("cancels between fresh identity lookup and mutation", async () => {
  const record = job();
  const controller = new AbortController();
  const execute = vi.fn(async () => {
    controller.abort();
    return '{"metadata":{"uid":"uid-a"}}';
  });
  await runNodeBulkJob(record, controller.signal, () => {}, execute);
  expect(record.nodes.map((n) => n.status)).toEqual(["cancelled", "skipped"]);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("does not expose raw execution failures", async () => {
  const record = job();
  await runNodeBulkJob(
    record,
    new AbortController().signal,
    () => {},
    async () => {
      throw Error("credential-secret");
    },
  );
  expect(JSON.stringify(record)).not.toContain("credential-secret");
});
it("kills an active subprocess on cancellation and redacts process errors", async () => {
  const kill = vi.fn();
  let finish: (...args: unknown[]) => void;
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
    finish = callback;
    return { kill };
  });
  const controller = new AbortController();
  const execution = executeNodeKubectl("/neutral/kubectl", ["drain", "node-a"], controller.signal, () => {});
  controller.abort();
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  finish!(Error("credential-secret"), "", "credential-secret");
  await expect(execution).rejects.toThrow(NodeBulkError);
});
it("rejects untrusted senders and changed context before execution", async () => {
  const stop = startNodeBulk();
  const handler = mocks.handle.mock.calls[0][1];
  const event = { sender: Object.assign(new EventEmitter(), { id: 1 }), senderFrame: { processId: 1, routingId: 1 } };
  mocks.trusted.mockReturnValue(false);
  expect((await handler(event, { operation: "context", clusterId: "cluster" })).ok).toBe(false);
  expect(mocks.cluster).not.toHaveBeenCalled();
  mocks.trusted.mockReturnValue(true);
  const context = await handler(event, { operation: "context", clusterId: "cluster" });
  mocks.config = "changed";
  const result = await handler(event, {
    operation: "begin",
    clusterId: "cluster",
    contextId: context.contextId,
    action: "cordon",
    confirmed: true,
    nodes: [{ name: "node-a", uid: "uid-a" }],
  });
  expect(result.error.code).toBe("context-changed");
  expect(mocks.exec).not.toHaveBeenCalled();
  stop();
});
it("read-only mode kills a running job and prevents the next node", async () => {
  const stop = startNodeBulk();
  const handler = mocks.handle.mock.calls[0][1];
  const event = { sender: Object.assign(new EventEmitter(), { id: 1 }), senderFrame: { processId: 1, routingId: 1 } };
  const context = await handler(event, { operation: "context", clusterId: "cluster" });
  const kill = vi.fn();
  let finish: (...args: unknown[]) => void;
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
    finish = callback;
    return { kill };
  });
  const result = await handler(event, {
    operation: "begin",
    clusterId: "cluster",
    contextId: context.contextId,
    action: "cordon",
    confirmed: true,
    nodes: [
      { name: "node-a", uid: "uid-a" },
      { name: "node-b", uid: "uid-b" },
    ],
  });
  runInAction(() => {
    mocks.readOnly.enabled = true;
  });
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  finish!(Error("cancelled"), "", "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = await handler(event, {
    operation: "status",
    clusterId: "cluster",
    contextId: context.contextId,
    jobId: result.job.id,
  });
  expect(status.job.status).toBe("cancelled");
  expect(status.job.nodes.map((n) => n.status)).toEqual(["cancelled", "skipped"]);
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  stop();
});

const privateConfig = () =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    "current-context": "neutral",
    contexts: [{ name: "neutral", context: { cluster: "neutral", user: "neutral" } }],
    clusters: [
      { name: "neutral", cluster: { server: "https://cluster.invalid", "certificate-authority-data": "private-ca" } },
    ],
    users: [
      {
        name: "neutral",
        user: { token: "private-token", exec: { command: "./plugins/auth", args: ["private-auth-arg"] } },
      },
    ],
  });
async function beginJob() {
  const stop = startNodeBulk();
  const handler = mocks.handle.mock.calls[0][1];
  const event = { sender: Object.assign(new EventEmitter(), { id: 1 }), senderFrame: { processId: 1, routingId: 1 } };
  const context = await handler(event, { operation: "context", clusterId: "cluster" });
  const result = await handler(event, {
    operation: "begin",
    clusterId: "cluster",
    contextId: context.contextId,
    action: "cordon",
    confirmed: true,
    nodes: [
      { name: "node-a", uid: "uid-a" },
      { name: "node-b", uid: "uid-b" },
    ],
  });
  return {
    stop,
    handler,
    event,
    context,
    result,
    status: () =>
      handler(event, { operation: "status", clusterId: "cluster", contextId: context.contextId, jobId: result.job.id }),
  };
}
function mockSuccessfulCommands() {
  mocks.exec.mockImplementation((_binary, args, _options, callback) => {
    const stdout = args.includes("view")
      ? privateConfig()
      : args.includes("get")
        ? JSON.stringify({ metadata: { uid: args.includes("node-a") ? "uid-a" : "uid-b" } })
        : "";
    queueMicrotask(() => callback(null, stdout));
    return { kill: vi.fn() };
  });
}
it("binds all node reads and changes to one private flattened snapshot and removes credentials afterwards", async () => {
  mockSuccessfulCommands();
  const session = await beginJob();
  try {
    await vi.waitFor(async () => expect((await session.status()).job.status).toBe("succeeded"));
    expect(mocks.exec.mock.calls[0][1]).toEqual([
      "--kubeconfig",
      "/neutral/config",
      "--context",
      "neutral",
      "config",
      "view",
      "--raw",
      "--flatten",
      "--minify",
      "--output=json",
    ]);
    for (const call of mocks.exec.mock.calls.slice(1)) {
      expect(call[1].slice(0, 4)).toEqual(["--kubeconfig", "/neutral/private-job/config.json", "--context", "neutral"]);
      expect(call[1]).not.toContain("/neutral/config");
    }
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(mocks.chmod).toHaveBeenCalledWith("/neutral/private-job", 0o700);
    expect(mocks.write.mock.calls[0][2]).toEqual({ mode: 0o600, flag: "wx" });
    const written = JSON.parse(mocks.write.mock.calls[0][1]);
    expect(written.users[0].user.exec.command).toBe("/neutral/plugins/auth");
    expect(written.clusters[0].cluster["certificate-authority-data"]).toBe("private-ca");
    expect(JSON.stringify(await session.status())).not.toMatch(/private-token|private-ca|private-auth-arg|private-job/);
    expect(mocks.rm).toHaveBeenCalledWith("/neutral/private-job", { recursive: true, force: true });
  } finally {
    session.stop();
  }
});
it("lets the owner poll and cancel an old context after configuration changes stop its subprocess", async () => {
  vi.useFakeTimers();
  const kill = vi.fn();
  let finish: (...args: unknown[]) => void;
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
    finish = callback;
    return { kill };
  });
  const session = await beginJob();
  try {
    mocks.config = "external-context-change";
    await vi.advanceTimersByTimeAsync(250);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    finish!(Error("private-credential-error"), "", "private-token");
    await vi.advanceTimersByTimeAsync(0);
    const status = await session.status();
    expect(status.ok).toBe(true);
    expect(status.job.status).toBe("cancelled");
    expect(JSON.stringify(status)).not.toContain("private-credential");
    expect(
      (
        await session.handler(session.event, {
          operation: "cancel",
          clusterId: "cluster",
          contextId: session.context.contextId,
          jobId: session.result.job.id,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await session.handler(
          { ...session.event, senderFrame: { processId: 1, routingId: 2 } },
          {
            operation: "status",
            clusterId: "cluster",
            contextId: session.context.contextId,
            jobId: session.result.job.id,
          },
        )
      ).ok,
    ).toBe(false);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  } finally {
    session.stop();
    vi.useRealTimers();
  }
});
it("rejects a snapshot of a different context without creating a private file or launching node commands", async () => {
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback(null, privateConfig().replaceAll('"neutral"', '"other"')));
    return { kill: vi.fn() };
  });
  const session = await beginJob();
  try {
    await vi.waitFor(async () => expect((await session.status()).job.status).toBe("failed"));
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
  } finally {
    session.stop();
  }
});
it("removes the private snapshot if file writing fails and keeps its errors out of progress", async () => {
  mockSuccessfulCommands();
  mocks.write.mockImplementationOnce(() => {
    throw Error("private-token");
  });
  const session = await beginJob();
  try {
    await vi.waitFor(async () => expect((await session.status()).job.status).toBe("failed"));
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledWith("/neutral/private-job", { recursive: true, force: true });
    expect(JSON.stringify(await session.status())).not.toContain("private-token");
  } finally {
    session.stop();
  }
});
it("removes a snapshot after cancelling an active node lookup and starts no mutations", async () => {
  const kill = vi.fn();
  let finish: (...args: unknown[]) => void;
  mocks.exec.mockImplementation((_binary, args, _options, callback) => {
    if (args.includes("view")) queueMicrotask(() => callback(null, privateConfig()));
    else finish = callback;
    return { kill };
  });
  const session = await beginJob();
  try {
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(2));
    await session.handler(session.event, {
      operation: "cancel",
      clusterId: "cluster",
      contextId: session.context.contextId,
      jobId: session.result.job.id,
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    finish!(Error("cancelled"), "", "private-token");
    await vi.waitFor(async () => expect((await session.status()).job.status).toBe("cancelled"));
    expect(mocks.rm).toHaveBeenCalledWith("/neutral/private-job", { recursive: true, force: true });
    expect(mocks.exec).toHaveBeenCalledTimes(2);
  } finally {
    session.stop();
  }
});
