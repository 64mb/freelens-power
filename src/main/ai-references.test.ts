import { describe, expect, it } from "vitest";
import { normalizeAiReferences } from "../common/ai-extras";
import { collectAiReferences } from "./ai-references";
import { summarizeAiResource } from "./ai-resources";

const query = { apiVersion: "v1", kind: "Pod", namespace: "default" };

describe("AI resource references", () => {
  it("collects exact identities from successful sanitized summaries", () => {
    const summary = summarizeAiResource(
      {
        items: [{ kind: "Pod", metadata: { name: "worker", namespace: "default" } }],
      },
      query,
    );
    expect(collectAiReferences(summary, query)).toEqual([
      { apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" },
    ]);
    expect(collectAiReferences(summary, { ...query, namespace: "other" })).toEqual([]);
    expect(collectAiReferences(summary, { ...query, kind: "Secret" })).toEqual([]);
  });

  it("never restores names or namespaces hidden as environment values", () => {
    const resource = {
      kind: "Pod",
      metadata: { name: "worker", namespace: "default" },
      spec: { containers: [{ env: [{ name: "VALUE", value: "worker" }] }] },
    };
    expect(collectAiReferences(summarizeAiResource(resource, query), query)).toEqual([]);
    resource.spec.containers[0].env[0].value = "default";
    expect(collectAiReferences(summarizeAiResource(resource, query), query)).toEqual([]);
  });

  it("rejects raw resources, forged identities and arbitrary paths", () => {
    expect(collectAiReferences({ kind: "Pod", metadata: { name: "worker", namespace: "default" } }, query)).toEqual([]);
    expect(
      normalizeAiReferences([
        { apiVersion: "v1", kind: "Pod", name: "../worker" },
        { apiVersion: "https://example.invalid", kind: "Pod", name: "worker" },
      ]),
    ).toEqual([]);
  });

  it("bounds, deduplicates and projects persisted references", () => {
    const item = { apiVersion: "v1", kind: "Node", name: "worker", url: "https://example.invalid", secret: "withheld" };
    expect(normalizeAiReferences([item, item])).toEqual([{ apiVersion: "v1", kind: "Node", name: "worker" }]);
    expect(
      normalizeAiReferences(Array.from({ length: 300 }, (_, index) => ({ ...item, name: `worker-${index}` }))),
    ).toHaveLength(200);
  });
});

it.each([
  { apiVersion: "example.com/v1", kind: "Widget", resource: "widgetrecords" },
  { apiVersion: "v1", kind: "ServiceAccount", resource: "serviceaccounts" },
])("keeps discovered approved $kind references without static kind assumptions", (approved) => {
  const query = { ...approved, namespace: "default" };
  const summary = summarizeAiResource(
    { items: [{ ...approved, metadata: { name: "worker", namespace: "default" } }] },
    query,
  );
  expect(collectAiReferences(summary, query)).toEqual([
    { apiVersion: approved.apiVersion, kind: approved.kind, name: "worker", namespace: "default" },
  ]);
});

it.each([
  "Widget",
  "example.com/v1",
])("never reintroduces an approved identity matching the hidden environment value %s", (hidden) => {
  const query = { apiVersion: "example.com/v1", kind: "Widget", namespace: "default" };
  const summary = summarizeAiResource(
    {
      ...query,
      metadata: { name: "worker", namespace: "default" },
      spec: { containers: [{ env: [{ name: "VALUE", value: hidden }] }] },
    },
    query,
  );
  expect(JSON.stringify(summary)).not.toContain(hidden);
  expect(collectAiReferences(summary, query)).toEqual([]);
});
