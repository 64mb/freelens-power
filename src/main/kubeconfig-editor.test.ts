import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KUBECONFIG_EDITOR_CHANNEL, KUBECONFIG_EDITOR_MAX_BYTES } from "../common/kubeconfig-editor";
import { startKubeconfigEditor } from "./kubeconfig-editor";

const state = vi.hoisted(() => ({
  handlers: new Map(),
  path: "",
  power: { enabled: true },
  readonly: { enabled: false },
  trusted: true,
}));
vi.mock("@freelensapp/extensions", () => ({
  Main: {
    Catalog: { getClusterById: (id: string) => (id === "example" ? { kubeConfigPath: state.path } : undefined) },
  },
}));
vi.mock("./cluster-icons", () => ({ trustedClusterIconsSender: () => state.trusted }));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => state.power },
}));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => state.readonly },
}));
vi.mock("./power-ipc", () => ({
  powerIpc: {
    handle: (channel: string, handler: unknown) => state.handlers.set(channel, handler),
    removeHandler: (channel: string) => state.handlers.delete(channel),
  },
}));

let directory: string;
let dispose: () => void;
const original = "apiVersion: v1\nkind: Config\n# preserve this comment\nclusters: []\n";
const request = (payload: unknown) => state.handlers.get(KUBECONFIG_EDITOR_CHANNEL)({}, payload);
const read = () => request({ operation: "read", clusterId: "example" });
const save = (text: string, revision: string) => request({ operation: "save", clusterId: "example", text, revision });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "power-editor-"));
  state.path = join(directory, "config");
  await writeFile(state.path, original, { mode: 0o640 });
  state.power.enabled = true;
  state.readonly.enabled = false;
  state.trusted = true;
  dispose = startKubeconfigEditor();
});
afterEach(async () => {
  dispose();
  await rm(directory, { recursive: true, force: true });
});

it("reads exact source and saves only explicit requests while preserving mode", async () => {
  const result = await read();
  expect(result).toMatchObject({ text: original, readOnly: false });
  expect(await readFile(state.path, "utf8")).toBe(original);
  const text = `${original}contexts: []\n`;
  const saved = await save(text, result.revision);
  expect(saved.text).toBe(text);
  expect(saved.revision).not.toBe(result.revision);
  expect(await readFile(state.path, "utf8")).toBe(text);
  expect((await stat(state.path)).mode & 0o777).toBe(0o640);
});
it.each([
  "apiVersion: [",
  "apiVersion: v2\nkind: Config",
  "- value",
  "apiVersion: v1\nkind: Other",
])("rejects invalid kubeconfig", async (text) => {
  const result = await read();
  await expect(save(text, result.revision)).rejects.toThrow("Kubeconfig editor request could not be completed");
  expect(await readFile(state.path, "utf8")).toBe(original);
});
it.each([
  "clusters: broken",
  "contexts: 42",
  "users: false",
  "clusters: [null]",
  "contexts: [{name: sample}]",
  "users: [{name: sample, user: false}]",
  "clusters: [{name: '', cluster: {}}]",
  "contexts: [{name: 42, context: {}}]",
  "users: [{name: sample, user: {}}, {name: sample, user: {}}]",
  "current-context: []",
  "preferences: false",
])("rejects invalid kubeconfig field shape: %s", async (fields) => {
  const result = await read();
  await expect(save(`apiVersion: v1\nkind: Config\n${fields}\n`, result.revision)).rejects.toThrow();
  expect(await readFile(state.path, "utf8")).toBe(original);
});
it.each([
  "",
  "clusters: []\ncontexts: []\nusers: []\ncurrent-context: ''\npreferences: {}\n",
  "clusters: null\ncontexts: null\nusers: null\ncurrent-context: null\npreferences: null\n",
  "clusters: [{name: sample, cluster: {}}]\ncontexts: []\nusers: null\n",
  "clusters: [{name: sample, cluster: null}]\ncontexts: [{name: sample, context: null}]\nusers: [{name: sample, user: null}]\n",
  "clusters: [{name: sample, cluster: {}}]\ncontexts: [{name: sample, context: {}}]\nusers: [{name: sample, user: {}}]\n",
])("accepts minimal and empty kubeconfig collections", async (fields) => {
  const result = await read();
  const text = `apiVersion: v1\nkind: Config\n${fields}`;
  expect((await save(text, result.revision)).text).toBe(text);
  expect(await readFile(state.path, "utf8")).toBe(text);
});
it("rejects external edits", async () => {
  const result = await read();
  await writeFile(state.path, `${original}contexts: []\n`);
  await expect(save(original, result.revision)).rejects.toThrow();
});
it("reads in read-only mode and rejects writes", async () => {
  state.readonly.enabled = true;
  const result = await read();
  expect(result.readOnly).toBe(true);
  await expect(save(original, result.revision)).rejects.toThrow();
});
it("rejects disabled power, untrusted senders and unknown clusters", async () => {
  state.power.enabled = false;
  await expect(read()).rejects.toThrow();
  state.power.enabled = true;
  state.trusted = false;
  await expect(read()).rejects.toThrow();
  state.trusted = true;
  await expect(request({ operation: "read", clusterId: "missing", path: state.path })).rejects.toThrow();
});
it("removes the handler and rejects a retained handler after disposal", async () => {
  const handler = state.handlers.get(KUBECONFIG_EDITOR_CHANNEL);
  dispose();
  expect(state.handlers.has(KUBECONFIG_EDITOR_CHANNEL)).toBe(false);
  await expect(handler({}, { operation: "read", clusterId: "example" })).rejects.toThrow();
});
it("rejects symbolic links and oversized input", async () => {
  const result = await read();
  await expect(save("a".repeat(KUBECONFIG_EDITOR_MAX_BYTES + 1), result.revision)).rejects.toThrow();
  const target = state.path;
  state.path = join(directory, "link");
  await symlink(target, state.path);
  await expect(read()).rejects.toThrow();
  state.path = target;
  await writeFile(target, Buffer.alloc(KUBECONFIG_EDITOR_MAX_BYTES + 1));
  await expect(read()).rejects.toThrow();
});
it("rejects simultaneous saves to the same file", async () => {
  const result = await read();
  const outcomes = await Promise.allSettled([save(original, result.revision), save(original, result.revision)]);
  expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
});
