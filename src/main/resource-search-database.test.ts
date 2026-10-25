import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectSearchDocuments, type SearchDocument } from "../common/resource-search";
import { ResourceSearchDatabase } from "./resource-search-database";
import { ResourceSearchWorker } from "./resource-search-worker";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "power-search-"));
  directories.push(directory);
  return join(directory, "search.sqlite");
}
const partition = { clusterId: "cluster-one", contextId: "context-one" };
function document(name: string, kind = "Secret", namespace = "example"): SearchDocument {
  return {
    kind,
    name,
    namespace,
    path: `/api/v1/namespaces/${namespace}/secrets/${name}`,
    group: "",
    version: "v1",
    resource: "secrets",
    uid: `uid-${name}`,
    labels: { app: "example" },
  };
}
function scan(db: ResourceSearchDatabase, documents: SearchDocument[], scanId = "scan-one", scope = "secrets/*") {
  db.run({ ...partition, operation: "begin", scope, scanId });
  db.run({ ...partition, operation: "append", scope, scanId, documents });
}

it("applies common kind priority before pagination only when relevance is equal", () => {
  const db = new ResourceSearchDatabase(databasePath());
  try {
    scan(
      db,
      [
        document("target-other", "Custom"),
        document("target-other", "Service"),
        document("target-other", "Pod"),
        document("target", "Custom"),
      ].map((item) => ({ ...item, path: `/${item.kind}/${item.name}` })),
    );
    expect(db.query(partition.clusterId, partition.contextId, "target", 3).documents.map((item) => item.kind)).toEqual([
      "Custom",
      "Pod",
      "Service",
    ]);
    expect(db.query(partition.clusterId, partition.contextId, "", 2).documents.map((item) => item.kind)).toEqual([
      "Pod",
      "Service",
    ]);
  } finally {
    db.close();
  }
});

it("pages through all ranked matches beyond the maximum query batch", () => {
  const db = new ResourceSearchDatabase(databasePath());
  try {
    const documents = Array.from({ length: 1105 }, (_, index) => document(`match-${String(index).padStart(4, "0")}`));
    scan(db, documents);
    const first = db.query(partition.clusterId, partition.contextId, "", 1000);
    const second = db.query(partition.clusterId, partition.contextId, "", 1000, { offset: 1000 });
    expect(first.documents).toHaveLength(1000);
    expect(first.hasMore).toBe(true);
    expect(second.documents).toHaveLength(105);
    expect(second.total).toBe(1105);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.documents, ...second.documents].map((item) => item.path)).size).toBe(1105);
  } finally {
    db.close();
  }
});

describe("persistent resource search", () => {
  it("finds Secrets and objects beyond the old inventory cap, including ordered parts and typos", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(
      db,
      Array.from({ length: 700 }, (_, index) => document(index === 699 ? "k8s-lockbox-secret" : `inventory-${index}`)),
    );
    db.run({ ...partition, operation: "complete", scope: "secrets/*", scanId: "scan-one" });
    expect(db.query(partition.clusterId, partition.contextId, "k8s-secret").documents.map((item) => item.name)).toEqual(
      ["k8s-lockbox-secret"],
    );
    expect(db.query(partition.clusterId, partition.contextId, "lockbxo").documents[0]?.name).toBe("k8s-lockbox-secret");
    expect(db.query(partition.clusterId, partition.contextId, "inventory-650").documents[0]?.name).toBe(
      "inventory-650",
    );
    expect(db.query(partition.clusterId, partition.contextId, "", 30)).toEqual(
      expect.objectContaining({ total: 700, hasMore: true }),
    );
    db.close();
  });

  it("retains old rows after interrupted scans, removes deleted rows only on completion and rejects superseded pages", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [document("old"), document("kept")]);
    scan(db, [{ ...document("kept"), uid: "new-uid" }], "scan-two");
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(2);
    expect(() =>
      db.run({
        ...partition,
        operation: "append",
        scope: "secrets/*",
        scanId: "scan-one",
        documents: [document("late")],
      }),
    ).toThrow("superseded");
    db.run({ ...partition, operation: "complete", scope: "secrets/*", scanId: "scan-two" });
    expect(db.query(partition.clusterId, partition.contextId, "").documents).toEqual([
      expect.objectContaining({ name: "kept", uid: "new-uid" }),
    ]);
    db.close();
  });

  it("isolates clusters and removes previous credential partitions before returning results", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [document("first")]);
    db.run({ ...partition, clusterId: "cluster-two", operation: "begin", scope: "secrets/*", scanId: "scan-one" });
    expect(db.query("cluster-two", partition.contextId, "").total).toBe(0);
    db.run({ ...partition, contextId: "new-credentials", operation: "status" });
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(0);
    db.close();
  });

  it("persists only projected metadata and clears revoked scopes", () => {
    const path = databasePath();
    let db = new ResourceSearchDatabase(path);
    const projected = projectSearchDocuments([
      {
        ...document("safe"),
        data: { password: "payload-sentinel" },
        annotations: { original: "annotation-sentinel" },
        fields: [{ label: "data", text: "field-sentinel" }],
      },
    ]);
    scan(db, projected);
    db.close();
    const bytes = readFileSync(path);
    for (const sentinel of ["payload-sentinel", "annotation-sentinel", "field-sentinel"])
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
    db = new ResourceSearchDatabase(path);
    expect(db.query(partition.clusterId, partition.contextId, "safe").total).toBe(1);
    db.run({ ...partition, operation: "invalidate", scope: "secrets/*" });
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(0);
    db.close();
  });

  it("treats SQL and FTS operators as literal input and keeps exact names first", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [document("target"), document("target-copy"), document("targte")]);
    expect(db.query(partition.clusterId, partition.contextId, "target").documents[0].name).toBe("target");
    for (const input of ['" OR *', "%' OR 1=1 --", "NEAR(a b)", "a_b", "ab", "'"])
      expect(() => db.query(partition.clusterId, partition.contextId, input)).not.toThrow();
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(3);
    db.close();
  });

  it("reconciles changed collection catalogs and scopes without retaining revoked namespace rows", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [document("old")], "old", "/secrets/example");
    scan(db, [document("current")], "current", "/secrets/*");
    db.run({ ...partition, operation: "complete", scope: "/secrets/*", scanId: "current" });
    expect(db.query(partition.clusterId, partition.contextId, "").documents.map((item) => item.name)).toEqual([
      "current",
    ]);
    scan(db, [document("other")], "ns", "/secrets/other");
    db.run({ ...partition, operation: "invalidate", scope: "/secrets/*" });
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(0);
    scan(db, [document("kept")]);
    db.run({ ...partition, operation: "reconcile", resources: ["/secrets"] });
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(1);
    db.run({ ...partition, operation: "reconcile", resources: [] });
    expect(db.query(partition.clusterId, partition.contextId, "").total).toBe(0);
    db.close();
  });

  it("applies exact filters before limiting results", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [
      ...Array.from({ length: 500 }, (_, index) => document(`first-${index}`, "Secret", "first")),
      document("wanted", "Secret", "second"),
      { ...document("global"), namespace: undefined, path: "/api/v1/secrets/global" },
    ]);
    expect(db.query(partition.clusterId, partition.contextId, "", 1, { namespace: "second" }).documents[0].name).toBe(
      "wanted",
    );
    expect(db.query(partition.clusterId, partition.contextId, "", 1, { namespace: "" }).documents[0].name).toBe(
      "global",
    );
    expect(db.query(partition.clusterId, partition.contextId, "", 1, { kind: "ConfigMap" }).total).toBe(0);
    db.close();
  });

  it("rolls back a page exceeding its disk quota while retaining the previous inventory", () => {
    const db = new ResourceSearchDatabase(databasePath(), 512 * 1024);
    scan(db, [document("previous")]);
    const large = Array.from({ length: 500 }, (_, index) => ({
      ...document(`large-${index}`),
      labels: Object.fromEntries(Array.from({ length: 32 }, (_, label) => [`key-${label}`, "x".repeat(256)])),
    }));
    expect(() => scan(db, large, "oversize")).toThrow();
    expect(db.query(partition.clusterId, partition.contextId, "").documents.map((item) => item.name)).toEqual([
      "previous",
    ]);
    db.close();
  });

  it("ranks literal name matches ahead of more than a page of fuzzy and near-segment candidates", () => {
    const db = new ResourceSearchDatabase(databasePath());
    scan(db, [
      ...Array.from({ length: 1001 }, (_, index) => document(`a${index}-prodnection`)),
      document("z-production"),
    ]);
    for (const limit of [100, 1000])
      expect(db.query(partition.clusterId, partition.contextId, "production", limit).documents[0].name).toBe(
        "z-production",
      );
    scan(
      db,
      [
        ...Array.from({ length: 1001 }, (_, index) => document(`a${index}-k8sx-secret`)),
        document("z-k8s-lockbox-secret"),
      ],
      "parts",
    );
    expect(db.query(partition.clusterId, partition.contextId, "k8s-secret", 100).documents[0].name).toBe(
      "z-k8s-lockbox-secret",
    );
    db.close();
  });

  it("runs the serialized database engine in an independent worker", async () => {
    const worker = new ResourceSearchWorker(databasePath());
    try {
      await worker.call({ ...partition, operation: "begin", scope: "secrets/*", scanId: "worker-scan" });
      await worker.call({
        ...partition,
        operation: "append",
        scope: "secrets/*",
        scanId: "worker-scan",
        documents: [document("worker-object")],
      });
      expect(await worker.call({ ...partition, operation: "query", query: "worker" })).toEqual(
        expect.objectContaining({ total: 1 }),
      );
      expect(await worker.call({ ...partition, operation: "clear" })).toBe(true);
    } finally {
      worker.close();
    }
  });
});
