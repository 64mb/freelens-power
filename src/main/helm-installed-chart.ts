import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { stringify } from "yaml";
import { HelmError } from "./helm";

interface ChartFile {
  path: string;
  data: Buffer;
}
const unavailable = () =>
  new HelmError(
    "installed-chart-unavailable",
    "The installed release does not contain a complete standalone chart. Configure its original chart repository and refresh chart sources",
  );
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function installedChartFiles(source: unknown): ChartFile[] {
  if (!record(source) || !record(source.chart)) throw unavailable();
  const chart = source.chart;
  const metadata = chart.metadata;
  if (
    !record(metadata) ||
    !["v1", "v2"].includes(metadata.apiVersion) ||
    typeof metadata.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,252}$/.test(metadata.name) ||
    typeof metadata.version !== "string" ||
    !/^[0-9][a-zA-Z0-9.+-]{0,127}$/.test(metadata.version) ||
    (metadata.type !== undefined && metadata.type !== "application") ||
    !record(chart.values) ||
    !Array.isArray(chart.templates) ||
    chart.templates.length === 0
  )
    throw unavailable();
  if (chart.lock !== undefined && chart.lock !== null && !record(chart.lock)) throw unavailable();
  for (const dependencies of [metadata.dependencies, chart.lock?.dependencies, chart.dependencies])
    if (dependencies !== undefined && dependencies !== null && (!Array.isArray(dependencies) || dependencies.length))
      throw unavailable();
  const manifests = [
    source.manifest,
    ...(Array.isArray(source.hooks) ? source.hooks.map((hook) => hook?.manifest) : []),
  ];
  if (manifests.some((manifest) => typeof manifest === "string" && /^\s*#\s*Source:.*\/charts\//im.test(manifest)))
    throw unavailable();
  const files: ChartFile[] = [];
  const paths = new Set<string>();
  let bytes = 0;
  const add = (path: string, data: Buffer) => {
    const identity = path.normalize("NFC").toLowerCase();
    if (paths.has(identity) || files.length >= 2048 || bytes + data.length > 8 * 1024 * 1024) throw unavailable();
    archivePath(path);
    paths.add(identity);
    bytes += data.length;
    files.push({ path, data });
  };
  const decode = (value: unknown) => {
    if (
      typeof value !== "string" ||
      value.length > 12 * 1024 * 1024 ||
      value.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    )
      throw unavailable();
    const data = Buffer.from(value, "base64");
    if (data.toString("base64") !== value) throw unavailable();
    return data;
  };
  add("Chart.yaml", Buffer.from(stringify(metadata)));
  add("values.yaml", Buffer.from(stringify(chart.values)));
  if (chart.schema !== undefined && chart.schema !== null && chart.schema !== "") {
    const schema = decode(chart.schema);
    try {
      if (!record(JSON.parse(schema.toString("utf8")))) throw unavailable();
    } catch {
      throw unavailable();
    }
    add("values.schema.json", schema);
  }
  for (const [entries, templates] of [
    [chart.templates, true],
    [chart.files ?? [], false],
  ] as const) {
    if (!Array.isArray(entries) || entries.length > 2048) throw unavailable();
    for (const file of entries) {
      if (!record(file) || typeof file.name !== "string" || file.name.length > 1024) throw unavailable();
      const path = file.name;
      const parts = path.split("/");
      const lower = path.toLowerCase();
      if (
        /[\\\x00-\x1f\x7f:]/.test(path) ||
        parts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[.\s]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
            part.toLowerCase() === "charts",
        ) ||
        (templates ? !path.startsWith("templates/") : lower.startsWith("templates/")) ||
        ["chart.yaml", "chart.lock", "values.yaml", "values.schema.json"].includes(lower)
      )
        throw unavailable();
      add(path, decode(file.data));
    }
  }
  // files cannot also be parent directories on any supported filesystem
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) throw unavailable();
  }
  return files;
}

function archivePath(path: string) {
  const complete = `installed/${path}`;
  if (Buffer.byteLength(complete) <= 100) return { name: complete, prefix: "" };
  for (let split = complete.lastIndexOf("/"); split > 0; split = complete.lastIndexOf("/", split - 1)) {
    const prefix = complete.slice(0, split);
    const name = complete.slice(split + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw unavailable();
}

export function installedChartArchive(files: ChartFile[]) {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const { name, prefix } = archivePath(file.path);
    header.write(name, 0, 100, "utf8");
    const octal = (value: number, offset: number, width: number) =>
      header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(file.data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, file.data);
    const padding = (512 - (file.data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

export async function withInstalledChart<T>(files: ChartFile[], action: (path: string) => Promise<T>): Promise<T> {
  const archive = installedChartArchive(files);
  const directory = await mkdtemp(join(tmpdir(), "freelens-helm-chart-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "chart.tgz");
    await writeFile(path, archive, { mode: 0o600, flag: "wx" });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
