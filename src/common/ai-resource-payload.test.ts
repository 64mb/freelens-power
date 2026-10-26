import { expect, it } from "vitest";
import { redactKubernetesJsonText, redactKubernetesPayload } from "./ai-resource-payload";

it("masks payload values by Kubernetes resource origin and preserves keys without mutation", () => {
  const secret = { kind: "Secret", data: { ordinary: "private", token: "private" }, metadata: { name: "example" } };
  const value = {
    kind: "List",
    items: [secret, { kind: "Pod", data: { ordinary: "visible" }, spec: { token: "visible" } }],
  };
  expect(redactKubernetesPayload(value)).toEqual({
    kind: "List",
    items: [{ ...secret, data: { ordinary: "[REDACTED]", token: "[REDACTED]" } }, value.items[1]],
  });
  expect(secret.data.ordinary).toBe("private");
  expect(redactKubernetesPayload({ data: { ordinary: "visible" } })).toEqual({ data: { ordinary: "visible" } });
});

it("redacts all ConfigMap payload fields and recursively serialized resources and annotations", () => {
  const resource = {
    kind: "ConfigMap",
    data: { file: "private" },
    binaryData: { binary: "private" },
    stringData: { text: "private" },
  };
  const value = {
    encoded: JSON.stringify(resource),
    metadata: {
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify(resource),
      },
    },
  };
  expect(JSON.stringify(redactKubernetesPayload(value))).not.toContain("private");
  expect(redactKubernetesPayload({ "kubectl.kubernetes.io/last-applied-configuration": "malformed private" })).toEqual({
    "kubectl.kubernetes.io/last-applied-configuration": "[REDACTED]",
  });
});

it("preserves ordinary JSON numeric lexemes while replacing entire payload values", () => {
  const text =
    '{"id":9007199254740993,"ratio":1.2300,"nested":{"kind":"Secret","data":{"a":{"nested":"private"},"b":123}},"token":"visible"}';
  const safe = redactKubernetesJsonText(text);
  expect(safe).toContain('"id":9007199254740993');
  expect(safe).toContain('"ratio":1.2300');
  expect(JSON.parse(safe).nested.data).toEqual({ a: "[REDACTED]", b: "[REDACTED]" });
  expect(JSON.parse(safe).token).toBe("visible");
  expect(redactKubernetesJsonText(safe)).toBe(safe);
});

it("masks duplicate fields, escaped kinds and malformed payload fields", () => {
  const safe = redactKubernetesJsonText(
    '{"kind":"Secr\\u0065t","data":{"key":"private-first"},"data":{"key":"private-second"},"stringData":"private-invalid"}',
  );
  expect(safe).not.toContain("private-");
  expect(safe.match(/\[REDACTED\]/g)).toHaveLength(3);
  expect(redactKubernetesPayload({ kind: "ConfigMap", data: "private-invalid" })).toEqual({
    kind: "ConfigMap",
    data: "[REDACTED]",
  });
});

it("bounds cyclic and excessively deep objects and JSON safely", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(redactKubernetesPayload(cyclic)).toEqual({ self: "[REDACTED]" });
  const deep = "[".repeat(1000) + '{"kind":"Secret","data":{"key":"private"}}' + "]".repeat(1000);
  expect(redactKubernetesJsonText(deep)).toBe('"[REDACTED]"');
});

it("infers payload origin for nested typed list entries lacking individual kinds", () => {
  for (const kind of ["SecretList", "ConfigMapList"]) {
    const value = { nested: { kind, items: [{ metadata: { name: "example" }, data: { file: "private" } }] } };
    const safe = redactKubernetesPayload(value);
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(redactKubernetesJsonText(JSON.stringify(value))).not.toContain("private");
    expect(redactKubernetesPayload({ encoded: JSON.stringify(value) })).toEqual({ encoded: JSON.stringify(safe) });
  }
});

it("redacts recognized YAML resource strings nested in structured attachments", () => {
  const value = { encoded: "kind: ConfigMap\ndata:\n  file: private\nmetadata:\n  name: example" };
  expect(JSON.stringify(redactKubernetesPayload(value))).not.toContain("private");
  expect(redactKubernetesJsonText(JSON.stringify(value))).not.toContain("private");
});

it("masks approved payload origins without overwriting actual kinds", () => {
  const value = { kind: "Pod", data: { file: "private-root" } };
  expect(redactKubernetesPayload(value, "Secret")).toEqual({ kind: "Pod", data: { file: "[REDACTED]" } });
  const list = { kind: "List", items: [{ kind: "Pod", data: { file: "private-list" } }] };
  expect(JSON.stringify(redactKubernetesPayload(list, "ConfigMap"))).not.toContain("private-");
  expect(redactKubernetesPayload({ kind: "Secret", data: { file: "private" } }, "Pod")).toEqual({
    kind: "Secret",
    data: { file: "[REDACTED]" },
  });
});

it("redacts resources nested through repeated JSON string encoding", () => {
  let value: unknown = { kind: "Secret", data: { key: "private-encoded" } };
  for (let index = 0; index < 6; index++) {
    value = JSON.stringify(value);
    expect(redactKubernetesJsonText(JSON.stringify(value))).not.toContain("private-encoded");
    expect(JSON.stringify(redactKubernetesPayload({ encoded: value }))).not.toContain("private-encoded");
  }
});

it("recognizes escaped and aliased kinds in YAML encoded inside objects and JSON strings", () => {
  for (const encoded of [
    'kind: "Secr\\u0065t"\ndata: {key: private-escaped}',
    "type: &type Secret\nkind: *type\ndata: {key: private-aliased}",
  ]) {
    expect(JSON.stringify(redactKubernetesPayload({ encoded }))).not.toContain("private-");
    expect(redactKubernetesJsonText(JSON.stringify({ encoded }))).not.toContain("private-");
  }
  expect(redactKubernetesPayload({ url: "https://example.invalid", message: "ordinary: text" })).toEqual({
    url: "https://example.invalid",
    message: "ordinary: text",
  });
});
