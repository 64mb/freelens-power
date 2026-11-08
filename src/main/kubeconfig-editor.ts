import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Main } from "@freelensapp/extensions";
import { isMap, parseDocument } from "yaml";
import {
  KUBECONFIG_EDITOR_CHANNEL,
  KUBECONFIG_EDITOR_MAX_BYTES,
  type KubeconfigEditorResponse,
} from "../common/kubeconfig-editor";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { trustedClusterIconsSender } from "./cluster-icons";
import { powerIpc } from "./power-ipc";

const revisionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const failure = () => new Error("Kubeconfig editor request could not be completed");

function validateKubeconfigShape(value: unknown): void {
  const mapping = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  if (!mapping(value)) throw failure();
  for (const [list, property] of [
    ["clusters", "cluster"],
    ["contexts", "context"],
    ["users", "user"],
  ] as const) {
    if (!Object.hasOwn(value, list)) continue;
    const entries = value[list];
    if (entries === null) continue;
    if (!Array.isArray(entries)) throw failure();
    const names = new Set<string>();
    for (const entry of entries) {
      if (
        !mapping(entry) ||
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        names.has(entry.name) ||
        (entry[property] !== null && !mapping(entry[property]))
      )
        throw failure();
      names.add(entry.name);
    }
  }
  if (
    Object.hasOwn(value, "current-context") &&
    value["current-context"] !== null &&
    typeof value["current-context"] !== "string"
  )
    throw failure();
  if (Object.hasOwn(value, "preferences") && value.preferences !== null && !mapping(value.preferences)) throw failure();
}

async function readFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > KUBECONFIG_EDITOR_MAX_BYTES) throw failure();
    const bytes = Buffer.alloc(KUBECONFIG_EDITOR_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > KUBECONFIG_EDITOR_MAX_BYTES) throw failure();
    const data = bytes.subarray(0, size);
    const current = await handle.stat();
    if (current.size !== size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw failure();
    return { text: data.toString("utf8"), revision: revisionOf(data), stat: current };
  } finally {
    await handle.close();
  }
}

export function startKubeconfigEditor(): () => void {
  let active = true;
  const saving = new Set<string>();
  powerIpc.handle(KUBECONFIG_EDITOR_CHANNEL, async (event, payload: unknown): Promise<KubeconfigEditorResponse> => {
    const available = () => {
      if (
        !active ||
        !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled ||
        !trustedClusterIconsSender(event)
      )
        throw failure();
    };
    const readOnly = () => ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled;
    let temporary: string | undefined;
    let locked: string | undefined;
    try {
      available();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure();
      const input = payload as { operation?: unknown; clusterId?: unknown; text?: unknown; revision?: unknown };
      if (typeof input.clusterId !== "string" || !input.clusterId || input.clusterId.length > 1024) throw failure();
      const clusterId = input.clusterId;
      const clusterPath = () => Main.Catalog.getClusterById(clusterId)?.kubeConfigPath;
      const selectedPath = clusterPath();
      if (!selectedPath) throw failure();
      const path = resolve(selectedPath);
      const check = () => {
        available();
        if (clusterPath() !== selectedPath) throw failure();
      };
      if (input.operation === "read") {
        const result = await readFile(path);
        check();
        return { text: result.text, revision: result.revision, readOnly: readOnly() };
      }
      if (
        input.operation !== "save" ||
        readOnly() ||
        typeof input.text !== "string" ||
        typeof input.revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.revision)
      )
        throw failure();
      const bytes = Buffer.from(input.text, "utf8");
      if (bytes.length > KUBECONFIG_EDITOR_MAX_BYTES) throw failure();
      const document = parseDocument(input.text, { uniqueKeys: true });
      if (
        document.errors.length ||
        !isMap(document.contents) ||
        document.get("apiVersion") !== "v1" ||
        document.get("kind") !== "Config"
      )
        throw failure();
      validateKubeconfigShape(document.toJS({ maxAliasCount: 100 }));
      if (saving.has(path)) throw failure();
      saving.add(path);
      locked = path;
      const previous = await readFile(path);
      if (previous.revision !== input.revision) throw failure();
      temporary = join(dirname(path), `.freelens-power-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(previous.stat.mode & 0o777);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const current = await readFile(path);
      const target = await lstat(path);
      check();
      if (
        readOnly() ||
        current.revision !== previous.revision ||
        target.isSymbolicLink() ||
        target.dev !== previous.stat.dev ||
        target.ino !== previous.stat.ino ||
        current.stat.ino !== previous.stat.ino ||
        current.stat.dev !== previous.stat.dev
      )
        throw failure();
      await rename(temporary, path);
      temporary = undefined;
      return { text: input.text, revision: revisionOf(bytes), readOnly: readOnly() };
    } catch {
      throw failure();
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      if (locked) saving.delete(locked);
    }
  });
  return () => {
    active = false;
    powerIpc.removeHandler(KUBECONFIG_EDITOR_CHANNEL);
  };
}
