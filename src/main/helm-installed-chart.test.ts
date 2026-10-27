import { execFileSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { installedChartFiles, withInstalledChart } from "./helm-installed-chart";

function entries(archive: Buffer) {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset < tar.length && tar[offset]; ) {
    const header = tar.subarray(offset, offset + 512);
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, "");
    const prefix = text(345, 155);
    const name = `${prefix ? `${prefix}/` : ""}${text(0, 100)}`;
    const expected = Number.parseInt(text(148, 8), 8);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 0x20 : byte), 0);
    expect(checksum).toBe(expected);
    expect(text(156, 1)).toBe("0");
    expect(Number.parseInt(text(100, 8), 8)).toBe(0o600);
    const size = Number.parseInt(text(124, 12), 8);
    files.set(name.replace(/^installed\//, ""), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
let helmAvailable = false;
try {
  execFileSync("helm", ["version", "--short"], { timeout: 5000, stdio: "ignore" });
  helmAvailable = true;
} catch {}
const encode = (text: string) => Buffer.from(text).toString("base64");
function source() {
  return {
    chart: {
      metadata: { apiVersion: "v2", name: "example", version: "1.2.3", dependencies: [] },
      values: { replicas: 1 },
      schema: encode('{"type":"object","properties":{"replicas":{"type":"integer"}}}'),
      templates: [{ name: "templates/deployment.yaml", data: encode("replicas: {{ .Values.replicas }}\n") }],
      files: [{ name: "assets/config.txt", data: encode("neutral content") }],
    },
    manifest: "# Source: example/templates/deployment.yaml\nreplicas: 1\n",
  };
}
describe("installed Helm chart", () => {
  it.each([
    false,
    true,
  ])("recreates chart defaults, templates, files and schema and cleans up after failure=%s", async (fail) => {
    let directory = "";
    const action = withInstalledChart(installedChartFiles(source()), async (path) => {
      directory = dirname(path);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const files = entries(await readFile(path));
      expect(files.get("Chart.yaml")?.toString()).toContain("version: 1.2.3");
      expect(files.get("values.yaml")?.toString()).toBe("replicas: 1\n");
      expect(files.get("templates/deployment.yaml")?.toString()).toContain("{{ .Values.replicas }}");
      expect(files.get("assets/config.txt")?.toString()).toBe("neutral content");
      expect(JSON.parse(files.get("values.schema.json")!.toString())).toHaveProperty("type", "object");
      if (fail) throw new Error("neutral failure");
      return "complete";
    });
    if (fail) await expect(action).rejects.toThrow("neutral failure");
    else await expect(action).resolves.toBe("complete");
    await expect(access(directory)).rejects.toThrow();
  });
  it.each([
    "../outside",
    "/outside",
    "assets/../../outside",
    "assets\\outside",
    "assets/\x00outside",
    "assets//outside",
    "Chart.yaml",
    "CHART.YAML",
    "values.yaml",
    "values.schema.json",
    "Chart.lock",
    "charts/child/values.yaml",
    "templates/overwrite.yaml",
    "assets/NUL.txt",
    "assets/value.",
    "assets/value ",
    "assets/a:secret",
  ])("rejects unsafe or reserved file path %s", (name) => {
    const value = source();
    value.chart.files = [{ name, data: encode("neutral") }];
    expect(() => installedChartFiles(value)).toThrow();
  });
  it("preserves ignore files, dot templates and long UTF-8 archive paths", async () => {
    const value = source();
    value.chart.files.push({ name: ".helmignore", data: encode("*.yaml\n") });
    value.chart.templates.push({ name: "templates/.hidden.yaml", data: encode("neutral hidden template") });
    const longPath = `assets/${"segment/".repeat(12)}${"файл".repeat(8)}.txt`;
    value.chart.files.push({ name: longPath, data: encode("long path content") });
    await withInstalledChart(installedChartFiles(value), async (path) => {
      const files = entries(await readFile(path));
      expect(files.get(".helmignore")?.toString()).toBe("*.yaml\n");
      expect(files.get("templates/.hidden.yaml")?.toString()).toBe("neutral hidden template");
      expect(files.get(longPath)?.toString()).toBe("long path content");
    });
    for (const name of [`assets/${"ф".repeat(51)}`, `${"long-segment/".repeat(30)}file.txt`]) {
      value.chart.files = [{ name, data: encode("neutral") }];
      expect(() => installedChartFiles(value)).toThrow(
        expect.objectContaining({ code: "installed-chart-unavailable" }),
      );
    }
  });
  it.skipIf(!helmAvailable)(
    "renders preserved dot templates and .Files.Get ignore contents with real Helm",
    async () => {
      const value = source();
      value.chart.templates = [
        {
          name: "templates/deployment.yaml",
          data: encode(
            'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ordinary\ndata:\n  ignore: {{ .Files.Get ".helmignore" | quote }}\n',
          ),
        },
        {
          name: "templates/.hidden.yaml",
          data: encode("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: hidden\ndata:\n  value: preserved\n"),
        },
      ];
      value.chart.files.push({ name: ".helmignore", data: encode("*.yaml\n") });
      await withInstalledChart(installedChartFiles(value), async (path) => {
        const rendered = execFileSync("helm", ["template", "neutral", path], { encoding: "utf8", timeout: 10_000 });
        expect(rendered).toContain("# Source: example/templates/.hidden.yaml");
        expect(rendered).toContain("name: hidden");
        expect(rendered).toContain('ignore: "*.yaml\\n"');
      });
    },
  );
  it("rejects missing templates, invalid encoding and duplicate filesystem identities", () => {
    const missing = source();
    missing.chart.templates = [];
    expect(() => installedChartFiles(missing)).toThrow();
    const bad = source();
    bad.chart.templates[0].data = "not-base64";
    expect(() => installedChartFiles(bad)).toThrow();
    const duplicate = source();
    duplicate.chart.files.push({ name: "ASSETS/config.txt", data: encode("neutral") });
    expect(() => installedChartFiles(duplicate)).toThrow();
    const parent = source();
    parent.chart.files.push({ name: "assets", data: encode("neutral") });
    expect(() => installedChartFiles(parent)).toThrow();
  });
  it("rejects declared, locked and undeclared subcharts", () => {
    for (const extra of [
      { chart: { ...source().chart, metadata: { ...source().chart.metadata, dependencies: [{ name: "child" }] } } },
      { chart: { ...source().chart, lock: { dependencies: [{ name: "child" }] } } },
      { manifest: "# Source: example/charts/child/templates/deploy.yaml\n" },
      { hooks: [{ manifest: "# Source: example/charts/child/templates/hook.yaml\n" }] },
    ])
      expect(() => installedChartFiles({ ...source(), ...extra })).toThrow();
  });
  it("rejects malformed schemas, excessive total bytes and excessive file counts", () => {
    const schema = source();
    schema.chart.schema = encode("invalid JSON");
    expect(() => installedChartFiles(schema)).toThrow();
    schema.chart.schema = encode("[]");
    expect(() => installedChartFiles(schema)).toThrow();
    const large = source();
    large.chart.files[0].data = encode("a".repeat(8 * 1024 * 1024));
    expect(() => installedChartFiles(large)).toThrow();
    const many = source();
    many.chart.files = Array.from({ length: 2048 }, (_, i) => ({ name: `assets/file-${i}`, data: "" }));
    expect(() => installedChartFiles(many)).toThrow();
  });
});
