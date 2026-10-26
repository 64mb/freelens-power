import { describe, expect, it } from "vitest";
import { redactAiTerminalText, sanitizeAiTerminalSnapshot } from "./ai-terminal-context";

const snapshot = (text: string) => sanitizeAiTerminalSnapshot({ text, capturedAt: "2026-01-01T00:00:00.000Z" });
describe("terminal attachment boundary", () => {
  it("preserves ordinary assignments, specs, logs and credential-like literals", () => {
    const text =
      "EXAMPLE=visible\npassword: visible\nenv:\n  - name: EXAMPLE\n    value: visible\nAuthorization: Bearer visible";
    expect(snapshot(text)?.text).toBe(text);
  });
  it("strips terminal escapes without masking ordinary text", () => {
    expect(snapshot("\u001b[31mready\u001b[0m")?.text).toBe("ready");
  });
  it("masks only Secret and ConfigMap payload map values in YAML", () => {
    const text =
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: example\ndata:\n  password: private-value\n  ordinary: |\n    private-block\n---\nkind: Pod\nspec:\n  value: visible";
    const result = snapshot(text)?.text;
    expect(result).toContain('password: "[REDACTED]"');
    expect(result).toContain('ordinary: "[REDACTED]"');
    expect(result).toContain("name: example");
    expect(result).toContain("value: visible");
    expect(result).not.toContain("private-");
  });
  it("limits rows and UTF-8 bytes", () => {
    const rows = snapshot(Array.from({ length: 400 }, (_, index) => `row ${index}`).join("\n"));
    expect(rows?.text.split("\n")).toHaveLength(300);
    expect(rows?.truncated).toBe(true);
    const bytes = snapshot(("界".repeat(100) + "\n").repeat(300));
    expect(new TextEncoder().encode(bytes?.text).length).toBeLessThanOrEqual(32 * 1024);
    expect(bytes?.truncated).toBe(true);
  });
  it("rejects malformed, empty and oversized snapshots", () => {
    for (const value of [
      null,
      {},
      { text: "ready", capturedAt: "invalid" },
      { text: "x".repeat(1_000_001), capturedAt: "2026-01-01" },
    ])
      expect(sanitizeAiTerminalSnapshot(value)).toBeUndefined();
    expect(snapshot(" \n")).toBeUndefined();
  });
});

it("preserves keys in YAML flow maps and masks encoded annotations", () => {
  const result = snapshot(
    "kind: 'ConfigMap'\ndata: {plain: private, quoted: 'private, value', nested: {a: private}}\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: malformed-private",
  );
  expect(result?.text).toContain('data: {plain: "[REDACTED]", quoted: "[REDACTED]", nested: "[REDACTED]"}');
  expect(result?.text).not.toContain("private");
});

it("handles nested YAML collections, duplicate fields, multiline values and aliases", () => {
  const text =
    'shared: &settings\n  file: private-anchor\nitems:\n  - "kind": "Secret"\n    data: *settings\n    data: {first: private-first, second: private-second}\n    stringData:\n      script: |\n        private-line\n        private-line2\n  - kind: Pod\n    spec:\n      token: visible\ncount: 9007199254740993\nratio: 1.2300';
  const result = snapshot(text)?.text;
  expect(result).not.toContain("private-");
  expect(result).toContain('file: "[REDACTED]"');
  expect(result).toContain('first: "[REDACTED]"');
  expect(result).toContain("token: visible");
  expect(result).toContain("count: 9007199254740993");
  expect(result).toContain("ratio: 1.2300");
});

it("masks recognizable malformed resource documents without changing ordinary logs", () => {
  expect(snapshot("kind: Secret\ndata: {key: private\n")?.text).not.toContain("private");
  const text =
    'start\n{"kind":"ConfigMap","data":{"key":"private"},"id":9007199254740993}\n{"level":"info","token":"visible","ratio":1.2300}\nend';
  const safe = snapshot(text)?.text;
  expect(safe).toContain("start\n");
  expect(safe).toContain('"key":"[REDACTED]"');
  expect(safe).not.toContain("private");
  expect(safe).toContain('"token":"visible","ratio":1.2300');
  expect(safe).toContain('"id":9007199254740993');
  expect(safe).toContain("\nend");
});

it("masks aliased payload scalar definitions and merge payload aliases without expansion", () => {
  const safe = snapshot(
    "value: &value private-scalar\nmerged: &merged {key: private-merged}\nkind: Secret\ndata:\n  direct: *value\n  <<: *merged",
  )?.text;
  expect(safe).not.toContain("private-");
  expect(safe).toContain('direct: "[REDACTED]"');
  expect(safe).toContain('key: "[REDACTED]"');
});

it("infers nested typed YAML list resource payloads without individual kinds", () => {
  const text =
    "wrapper:\n  kind: SecretList\n  items:\n    - metadata: {name: example}\n      data: {file: private}\nordinary:\n  data: {file: visible}";
  const safe = snapshot(text)?.text;
  expect(safe).not.toContain("private");
  expect(safe).toContain('file: "[REDACTED]"');
  expect(safe).toContain("data: {file: visible}");
});

it("redacts typed-list aliases, resource merges and encoded YAML block scalars", () => {
  const fixtures = [
    "entries: &entries\n  - data: {key: private-sequence}\nkind: SecretList\nitems: *entries",
    "base: &base\n  data: {key: private-merge}\nkind: Secret\n<<: *base",
    "ordinary: visible\nencoded: |\n  kind: Secret\n  data:\n    key: private-encoded\ntail: visible",
    '{"message":"visible"}\n---\nkind: SecretList\nitems:\n  - data: {key: private-mixed}',
  ];
  for (const text of fixtures) expect(snapshot(text)?.text).not.toContain("private-");
  expect(snapshot(fixtures[2])?.text).toContain("ordinary: visible");
  expect(snapshot(fixtures[2])?.text).toContain("tail: visible");
});

it("resolves alias shadowing and cycles within a bounded traversal", () => {
  const text =
    "first: &kind Secret\nobjects:\n  - kind: *kind\n    data: {key: private-first}\nsecond: &kind Pod\nordinary:\n  kind: *kind\n  data: {key: visible}";
  const safe = snapshot(text)?.text;
  expect(safe).not.toContain("private-first");
  expect(safe).toContain("key: visible");
  expect(snapshot("kind: Secret\nloop: &loop [*loop]\ndata: {key: private-cycle}")?.text).not.toContain(
    "private-cycle",
  );
});

it("examines YAML document ASTs after JSON lines for escaped, aliased and flow kinds", () => {
  for (const resource of [
    'kind: "Secr\\u0065t"\ndata: {key: private-escaped}',
    "type: &type Secret\nkind: *type\ndata: {key: private-aliased}",
    "{kind: Secret, data: {key: private-flow}}",
  ]) {
    const safe = snapshot('{"level":"info"}\n---\n' + resource)?.text;
    expect(safe).not.toContain("private-");
    expect(safe).toContain('{"level":"info"}');
  }
});

it("bounds repeated YAML merge aliases before materializing expanded entries", () => {
  const base = Array.from({ length: 1000 }, (_, index) => `key${index}: private-${index}`).join(", ");
  const aliases = (name: string) => Array(50).fill(`*${name}`).join(", ");
  const text = `base: &base {${base}}\none: &one {<<: [${aliases("base")}]}\ntwo: &two {<<: [${aliases("one")}]}\nkind: Secret\n<<: *two`;
  expect(snapshot(text)?.text).toBe('"[REDACTED]"');
});

it("keeps JSON lines inside YAML payload ranges rather than restoring their values", () => {
  for (const payload of [
    'data:\n  key: |\n    {"value":"private"}',
    'data: |\n  {"value":"private"}',
    'data:\n  key:\n    {"value":"private"}',
  ]) {
    const safe = snapshot(`kind: Secret\n${payload}\nmetadata: {name: example}`)?.text;
    expect(safe).not.toContain("private");
    expect(safe).toContain("name: example");
  }
  const pod = 'kind: Pod\nmetadata:\n  annotations:\n    example: |\n      {"value":"visible"}';
  expect(snapshot(pod)?.text).toBe(pod);
});

it("checks original YAML errors before restoring independent JSON log lines", () => {
  for (const text of [
    'kind: Secret\ndata:\n{"value":"private"}',
    'kind: Secret\ndata: { key:\n{"value":"private"}\n}\nmetadata: {name: example}',
  ])
    expect(snapshot(text)?.text).not.toContain("private");
});

it("preserves ordinary logs that mention resource kinds without payload origins", () => {
  for (const text of [
    "2026-01-01T12:00:00Z INFO kind: Secret name: example\n2026-01-01T12:00:01Z INFO reconciled successfully",
    "INFO received {kind: Secret, name: example}\nINFO ready",
  ])
    expect(snapshot(text)?.text).toBe(text);
});

it("preserves unrelated numeric lexemes in NDJSON when the first line is a resource", () => {
  const text = '{"kind":"Secret","data":{"key":"private"}}\n{"message":"visible","id":9007199254740993,"ratio":1.2300}';
  const safe = snapshot(text)?.text;
  expect(safe).not.toContain("private");
  expect(safe).toContain('{"message":"visible","id":9007199254740993,"ratio":1.2300}');
});

it("chooses collision-free JSON placeholders with a bounded source scan", () => {
  const prefix = "# __ai_json_line_" + "_".repeat(900000);
  const text = prefix + '\n{"level":"info"}';
  expect(redactAiTerminalText(text)).toBe(text);
  const collisions = Array.from({ length: 2000 }, (_, index) => `# __ai_json_line_${index}_0`).join("\n");
  const crowded = collisions + '\n{"level":"info"}';
  expect(redactAiTerminalText(crowded)).toBe(crowded);
}, 2000);
