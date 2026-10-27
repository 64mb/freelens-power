import { gunzipSync } from "node:zlib";
import { stringify } from "yaml";

import type { HelmDetail, HelmReleaseMetadata, HelmSection } from "../common/helm";

export class HelmError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () => new HelmError("invalid-data", "Helm release data is invalid or exceeds safety limits");
export function metadataRelease(value: unknown): HelmReleaseMetadata | undefined {
  const m = (
    value as {
      metadata?: {
        uid?: string;
        resourceVersion?: string;
        name?: string;
        namespace?: string;
        labels?: Record<string, string>;
        creationTimestamp?: string;
      };
    }
  )?.metadata;
  if (
    !m ||
    typeof m.name !== "string" ||
    typeof m.namespace !== "string" ||
    m.name.length > 300 ||
    m.namespace.length > 253
  )
    return;
  const match = /^sh\.helm\.release\.v1\.(.+)\.v([1-9]\d*)$/.exec(m.name);
  const l = m.labels;
  if (
    !match ||
    !l ||
    l.owner !== "helm" ||
    l.name !== match[1] ||
    l.version !== match[2] ||
    typeof l.status !== "string" ||
    !l.status ||
    l.status.length > 64 ||
    !Number.isSafeInteger(Number(match[2]))
  )
    return;
  const timestamp = Number(l.modifiedAt ?? l.createdAt);
  const updatedAt =
    Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000
      ? new Date(timestamp * 1000).toISOString()
      : m.creationTimestamp;
  return {
    name: match[1],
    namespace: m.namespace,
    revision: Number(match[2]),
    status: l.status,
    secretName: m.name,
    uid: typeof m.uid === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(m.uid) ? m.uid : undefined,
    resourceVersion:
      typeof m.resourceVersion === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(m.resourceVersion)
        ? m.resourceVersion
        : undefined,
    updatedAt,
  };
}
export function latestReleases(rows: HelmReleaseMetadata[]): HelmReleaseMetadata[] {
  const latest = new Map<string, HelmReleaseMetadata>();
  for (const row of rows) {
    const key = `${row.namespace}/${row.name}`;
    if ((latest.get(key)?.revision ?? 0) < row.revision) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
}
const MAX = 8 * 1024 * 1024;
function validateReleaseTree(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let projected = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 100_000 || depth > 64) throw invalid();
    projected += depth * 2 + 16;
    if (typeof value === "string") {
      let lines = 0;
      for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) lines++;
      projected += Buffer.byteLength(value) * 2 + lines * (depth * 2 + 4);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        projected += Buffer.byteLength(key) * 2 + 8;
        if (projected > MAX) throw invalid();
        pending.push({ value: child, depth: depth + 1 });
        if (pending.length > 100_000) throw invalid();
      }
    }
    if (projected > MAX) throw invalid();
  }
}
export function decodeRelease(encoded: unknown, expected: HelmReleaseMetadata): Record<string, any> {
  if (typeof encoded !== "string" || encoded.length > MAX * 2 || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded))
    throw invalid();
  try {
    const inner = Buffer.from(encoded, "base64").toString("utf8");
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(inner)) throw invalid();
    const compressed = Buffer.from(inner, "base64");
    const body =
      compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed, { maxOutputLength: MAX }) : compressed;
    if (body.length > MAX) throw invalid();
    const release = JSON.parse(body.toString("utf8"));
    if (
      !release ||
      release.name !== expected.name ||
      release.namespace !== expected.namespace ||
      release.version !== expected.revision
    )
      throw invalid();
    validateReleaseTree(release);
    return release;
  } catch {
    throw invalid();
  }
}
export function releaseDetail(release: Record<string, any>, section: HelmSection): HelmDetail {
  const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);
  const chartName = optionalText(release.chart?.metadata?.name);
  const chartVersion = optionalText(release.chart?.metadata?.version);
  const overview = {
    name: release.name,
    namespace: release.namespace,
    revision: release.version,
    status: optionalText(release.info?.status) ?? "unknown",
    chartName,
    chart: chartName ? `${chartName}-${chartVersion ?? ""}` : undefined,
    appVersion: optionalText(release.chart?.metadata?.appVersion),
    chartVersion,
    description: optionalText(release.info?.description),
    updatedAt: optionalText(release.info?.last_deployed),
  };
  const content =
    section === "values"
      ? stringify(release.config ?? {})
      : section === "manifest"
        ? String(release.manifest ?? "")
        : section === "notes"
          ? String(release.info?.notes ?? "")
          : stringify(overview);
  if (Buffer.byteLength(content) > MAX) throw invalid();
  return { overview, section, content, language: section === "notes" ? "plaintext" : "yaml" };
}
export class HelmLimiter {
  private count = 0;
  private waits: Array<() => void> = [];
  constructor(private maximum = 2) {}
  private release(): void {
    const next = this.waits.shift();
    if (next) next();
    else this.count--;
  }
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new HelmError("cancelled", "Helm request cancelled");
    if (this.count < this.maximum) this.count++;
    else {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          signal.removeEventListener("abort", abort);
          this.waits = this.waits.filter((x) => x !== wake);
          reject(new HelmError("cancelled", "Helm request cancelled"));
        };
        this.waits.push(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    try {
      if (signal.aborted) throw new HelmError("cancelled", "Helm request cancelled");
      return await action();
    } finally {
      this.release();
    }
  }
}
export interface HelmReader {
  (path: string, query: Record<string, string | number>, metadata: boolean, signal: AbortSignal): Promise<unknown>;
}
export class HelmService {
  private cache = new Map<string, { at: number; rows: HelmReleaseMetadata[] }>();
  private details = new Map<string, { at: number; release: Record<string, any> }>();
  private summaries = new Map<string, { at: number; appVersion?: string; chartVersion?: string }>();
  private generation = 0;
  constructor(
    private read: HelmReader,
    private now = Date.now,
  ) {}
  clear() {
    this.cache.clear();
    this.details.clear();
    this.summaries.clear();
    this.generation++;
  }
  async list(
    partition: string,
    namespace: string,
    signal: AbortSignal,
    name?: string,
    refresh = false,
    storageOnly = false,
  ) {
    const generation = this.generation;
    if (signal.aborted) throw new HelmError("cancelled", "Helm request cancelled");
    const suffix = storageOnly ? "\0helm-storage" : "";
    const key = `${partition}\0${namespace}\0${name ?? ""}${suffix}`;
    const entry = this.cache.get(key) ?? (name ? this.cache.get(`${partition}\0${namespace}\0${suffix}`) : undefined);
    if (!refresh && entry && this.now() - entry.at < 30_000)
      return { rows: name ? entry.rows.filter((r) => r.name === name) : entry.rows, fetchedAt: entry.at, cached: true };
    const rows: HelmReleaseMetadata[] = [];
    let token = "";
    for (let page = 0; ; page++) {
      if (page >= 4) throw new HelmError("limit", "Helm metadata exceeds the 4 page limit; select a namespace");
      const response: any = await this.read(
        `/api/v1/${namespace ? `namespaces/${encodeURIComponent(namespace)}/` : ""}secrets`,
        {
          labelSelector: `owner=helm${name ? `,name=${name}` : ""}`,
          ...(storageOnly ? { fieldSelector: "type=helm.sh/release.v1" } : {}),
          limit: 5000,
          ...(token ? { continue: token } : {}),
        },
        true,
        signal,
      );
      if (
        response?.kind !== "PartialObjectMetadataList" ||
        response?.apiVersion !== "meta.k8s.io/v1" ||
        (response.items !== null && !Array.isArray(response.items))
      )
        throw new HelmError(
          "metadata-unavailable",
          "The API server must support PartialObjectMetadataList; full Secret listing is disabled",
        );
      for (const item of response.items ?? []) {
        const row = metadataRelease(item);
        if (row && (!namespace || row.namespace === namespace) && (!name || row.name === name)) rows.push(row);
      }
      if (rows.length > 20_000)
        throw new HelmError("limit", "Helm metadata exceeds the release limit; select a namespace");
      token = response.metadata?.continue ?? "";
      if (typeof token !== "string" || token.length > 8192) throw invalid();
      if (!token) break;
    }
    if (generation !== this.generation || signal.aborted)
      throw new HelmError("cancelled", "Helm data changed or the request was cancelled; refresh releases");
    const at = this.now();
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at, rows });
    return { rows, fetchedAt: at, cached: false };
  }
  async appVersion(partition: string, row: HelmReleaseMetadata, signal: AbortSignal, refresh = false) {
    const key = `${partition}\0${row.namespace}\0${row.secretName}\0${row.uid ?? ""}`;
    const cached = this.summaries.get(key);
    if (!refresh && cached && this.now() - cached.at < 300_000) {
      this.summaries.delete(key);
      this.summaries.set(key, cached);
      return { appVersion: cached.appVersion, chartVersion: cached.chartVersion };
    }
    const generation = this.generation;
    const detail = await this.detail(partition, row, "overview", signal, refresh);
    const text = (value: unknown) =>
      typeof value === "string" && Buffer.byteLength(value) <= 1024 ? value : undefined;
    const summary = { appVersion: text(detail.overview.appVersion), chartVersion: text(detail.overview.chartVersion) };
    if (generation === this.generation && !signal.aborted) {
      this.summaries.delete(key);
      if (this.summaries.size >= 1000) this.summaries.delete(this.summaries.keys().next().value!);
      this.summaries.set(key, { at: this.now(), ...summary });
    }
    return summary;
  }
  async chartMetadata(partition: string, row: HelmReleaseMetadata, signal: AbortSignal) {
    const detail = await this.detail(partition, row, "overview", signal, true);
    const { chartName: name, chartVersion: version } = detail.overview;
    if (
      typeof name !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,252}$/.test(name) ||
      typeof version !== "string" ||
      !/^[0-9][a-zA-Z0-9.+-]{0,127}$/.test(version)
    )
      throw invalid();
    return { name, version };
  }
  async detail(
    partition: string,
    row: HelmReleaseMetadata,
    section: HelmSection,
    signal: AbortSignal,
    refresh = false,
  ): Promise<HelmDetail> {
    return releaseDetail(await this.release(partition, row, signal, refresh), section);
  }
  async installedChart(partition: string, row: HelmReleaseMetadata, signal: AbortSignal) {
    const release = await this.release(partition, row, signal, false);
    return { chart: release.chart, manifest: release.manifest, hooks: release.hooks };
  }
  private async release(partition: string, row: HelmReleaseMetadata, signal: AbortSignal, refresh: boolean) {
    const key = `${partition}\0${row.namespace}\0${row.secretName}\0${row.uid ?? ""}`;
    const generation = this.generation;
    let entry = this.details.get(key);
    if (refresh || !entry || this.now() - entry.at >= 15_000) {
      const secret: any = await this.read(
        `/api/v1/namespaces/${encodeURIComponent(row.namespace)}/secrets/${encodeURIComponent(row.secretName)}`,
        {},
        false,
        signal,
      );
      const actual = metadataRelease(secret);
      if (
        !actual ||
        actual.name !== row.name ||
        actual.revision !== row.revision ||
        actual.namespace !== row.namespace ||
        (row.uid !== undefined && actual.uid !== row.uid) ||
        secret.type !== "helm.sh/release.v1"
      )
        throw invalid();
      entry = { at: this.now(), release: decodeRelease(secret.data?.release, row) };
    }
    if (generation !== this.generation || signal.aborted)
      throw new HelmError("cancelled", "Helm data changed or the request was cancelled; refresh releases");
    this.details.delete(key);
    if (this.details.size >= 4) this.details.delete(this.details.keys().next().value!);
    this.details.set(key, entry);
    return entry.release;
  }
}
