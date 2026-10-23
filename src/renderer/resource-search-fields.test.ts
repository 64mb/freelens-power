import { expect, it } from "vitest";
import { projectSearchFields } from "./resource-search-fields";
import { createResourceSearchIndex, type SearchResource } from "./resource-search-model";

const resource = (kind: string, object: unknown, path = `/${kind}`): SearchResource => ({
  kind,
  name: "backend",
  namespace: "default",
  path,
  labels: { app: "api" },
  fields: projectSearchFields(kind, object),
});
it("indexes safe image, condition, selector, owner and scale target text across kinds", () => {
  const pod = resource("Pod", {
    spec: { containers: [{ name: "worker", image: "example/backend:v2" }] },
    status: {
      phase: "Pending",
      conditions: [{ type: "Ready", reason: "Unschedulable", message: "Insufficient memory on available nodes" }],
    },
  });
  const deployment = resource("Deployment", {
    spec: {
      template: { spec: { containers: [{ image: "example/backend:v3" }] } },
      selector: { matchLabels: { component: "processor" } },
      scaleTargetRef: { kind: "Deployment", name: "target-workload" },
    },
    metadata: { ownerReferences: [{ name: "controller-main", kind: "ReplicaSet" }] },
  });
  const index = createResourceSearchIndex([pod, deployment]);
  expect(index.search("Pod unschedulable memory")).toEqual([pod]);
  expect(index.search("backend:v3 component=processor controller-main target-workload")).toEqual([deployment]);
  expect(index.snippet(pod, "Pod unschedulable")).toEqual({ label: "Reason", text: "Unschedulable" });
  expect(index.snippet(pod, "backend")).toBeUndefined();
});
it("never projects env, annotations, arbitrary spec payloads or sensitive kinds", () => {
  const raw = {
    metadata: { annotations: { hidden: "annotation-private" } },
    spec: {
      containers: [
        {
          name: "api",
          image: "example/api",
          get env() {
            throw new Error("env must never be accessed");
          },
        },
      ],
      arbitrary: "private-payload",
    },
    data: { token: "private-data" },
  };
  const pod = resource("Pod", raw);
  const index = createResourceSearchIndex([pod, resource("Secret", raw), resource("ConfigMap", raw)]);
  expect(index.search("private")).toEqual([]);
  expect(index.search("Secret").map((item) => item.kind)).toEqual(["Secret"]);
  expect(index.search("ConfigMap").map((item) => item.kind)).toEqual(["ConfigMap"]);
  expect(index.search("example/api")).toEqual([pod]);
});
it("redacts freeform conditions and bounds projected fields and indexed documents", () => {
  const fields = projectSearchFields("Pod", {
    status: {
      conditions: [
        { message: "token: confidential-value" },
        ...Array.from({ length: 80 }, () => ({ message: "x".repeat(5000) })),
      ],
    },
  });
  expect(fields.map((field) => field.text).join(" ")).not.toContain("confidential-value");
  expect(fields.reduce((sum, field) => sum + field.text.length, 0)).toBeLessThanOrEqual(4096);
  expect(fields.length).toBeLessThanOrEqual(32);
  const pod = resource("Pod", {});
  pod.fields = [{ label: "Message", text: "x".repeat(5000) + "outside-boundary" }];
  expect(createResourceSearchIndex([pod]).search("outside-boundary")).toEqual([]);
});
it("rebuilds isolated indexes and searches snapshots without rereading projected fields", () => {
  const pod = resource("Pod", { status: { phase: "Pending" } });
  const before = createResourceSearchIndex([pod]);
  Object.defineProperty(pod, "fields", {
    get() {
      throw new Error("queries must use the index snapshot");
    },
  });
  expect(before.search("Pending")).toEqual([pod]);
  const after = createResourceSearchIndex([resource("Service", {})]);
  expect(after.search("Pending")).toEqual([]);
  expect(before.search("Pending")).toEqual([pod]);
});
