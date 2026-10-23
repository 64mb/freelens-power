import { expect, it } from "vitest";
import { boundedNameDistance } from "./resource-search-distance";
import { createResourceSearchIndex, type SearchResource } from "./resource-search-model";

const resource = (name: string, namespace = "production"): SearchResource => ({
  kind: "Pod",
  name,
  namespace,
  labels: {},
  path: `/${namespace}/${name}`,
});
it("handles deletion, insertion, substitution and adjacent transposition", () => {
  expect(boundedNameDistance("backen", "backend", 1)).toBe(1);
  expect(boundedNameDistance("backendd", "backend", 2)).toBe(1);
  expect(boundedNameDistance("backxnd", "backend", 2)).toBe(1);
  expect(boundedNameDistance("bakcend", "backend", 2)).toBe(1);
  expect(boundedNameDistance("different", "backend", 2)).toBeGreaterThan(2);
});
it("ranks exact and substring results above fuzzy names and labels approximate results", () => {
  const exact = resource("backend");
  const prefix = resource("backend-worker");
  const fuzzy = resource("backand");
  const index = createResourceSearchIndex([fuzzy, prefix, exact]);
  expect(index.search("backend")).toEqual([exact, prefix, fuzzy]);
  expect(index.similarName(exact)).toBe(false);
  expect(index.similarName(fuzzy)).toBe(true);
});
it("matches name segments with mixed namespace tokens but never fuzzy metadata or status", () => {
  const pod = resource("backend-worker-abc123");
  pod.fields = [{ label: "Reason", text: "Unschedulable" }];
  pod.labels = { component: "processor" };
  const index = createResourceSearchIndex([pod]);
  expect(index.search("production bakcend")).toEqual([pod]);
  expect(index.search("productoin")).toEqual([]);
  expect(index.search("procesor")).toEqual([]);
  expect(index.search("unschedulabe")).toEqual([]);
  expect(index.search("bak")).toEqual([]);
});
it("enforces short token and long string bounds and rebuilds fuzzy indexes", () => {
  const pod = resource("api");
  expect(createResourceSearchIndex([pod]).search("apx")).toEqual([]);
  expect(boundedNameDistance("x".repeat(65), "x".repeat(65), 2)).toBeGreaterThan(2);
  const index = createResourceSearchIndex([resource("backend")]);
  expect(index.search("bakcend")).toHaveLength(1);
  expect(createResourceSearchIndex([resource("other")]).search("bakcend")).toEqual([]);
  expect(index.search("x".repeat(301))).toEqual([]);
});
it("matches ordered exact name parts across gaps and preserves namespace AND matching", () => {
  const exact = resource("k8s-secret");
  const gapped = resource("k8s-lockbox-secret");
  const reverse = resource("secret-lockbox-k8s");
  const missing = resource("k8s-lockbox-config");
  const fuzzy = resource("k8s-secrat");
  const index = createResourceSearchIndex([gapped, reverse, missing, fuzzy, exact]);
  expect(index.search("k8s-secret")).toEqual([exact, gapped, fuzzy]);
  expect(index.nameParts(gapped)).toBe(true);
  expect(index.similarName(gapped)).toBe(false);
  expect(index.search("production k8s-secret")).toEqual([exact, gapped, fuzzy]);
  expect(index.search("staging k8s-secret")).toEqual([]);
});
it("keeps ordered parts name-only and excludes selector and path syntax", () => {
  const pod = resource("unrelated");
  pod.labels = { name: "k8s-lockbox-secret" };
  const index = createResourceSearchIndex([pod]);
  expect(index.search("k8s-secret")).toEqual([]);
  expect(index.search("name=k8s-secret")).toEqual([]);
  expect(index.search("k8s/secret")).toEqual([]);
});
