import { expect, it } from "vitest";
import { boundedAiJson, formatAiAttachmentText, normalizeAiAttachmentReceipts } from "./ai-attachments";

it("formats complete JSON without rounding numbers and preserves legacy prose", () => {
  expect(formatAiAttachmentText('{"id":9007199254740993,"ratio":1.2300}')).toBe(
    '{\n  "id": 9007199254740993,\n  "ratio": 1.2300\n}',
  );
  expect(formatAiAttachmentText("legacy { incomplete")).toBe("legacy { incomplete");
  expect(formatAiAttachmentText('{"token":"sample-sensitive","text":"hello"}', 8000, true)).toContain(
    "sample-sensitive",
  );
});

it("bounds structured evidence without cutting JSON and redacts before pruning", () => {
  const evidence = boundedAiJson(
    { error: "Query failed", data: "x".repeat(20000), nested: { password: "sample-sensitive" } },
    6000,
  );
  expect(evidence.length).toBeLessThanOrEqual(6000);
  expect(JSON.parse(evidence).error).toBe("Query failed");
  expect(evidence).toContain("sample-sensitive");
});

it("copies only plain bounded receipts without accepting inherited data", () => {
  const receipt = { kind: "evidence", title: "Snapshot", text: "x".repeat(20000), source: "logs" };
  const normalized = normalizeAiAttachmentReceipts([receipt, receipt, receipt, receipt]);
  expect(normalized).toHaveLength(3);
  expect(
    normalized.reduce((sum, item) => sum + item.title.length + item.text.length + (item.source?.length ?? 0), 0),
  ).toBeLessThanOrEqual(48000);
  receipt.title = "Changed";
  expect(normalized[0].title).toBe("Snapshot");
  expect(normalizeAiAttachmentReceipts([Object.create(receipt)])).toEqual([]);
});

it("preserves long terminal snapshots exactly and bounds oversized receipts explicitly", () => {
  const text = "sample output\n".repeat(1800);
  const [receipt] = normalizeAiAttachmentReceipts([{ kind: "terminal", title: "Terminal", text }]);
  expect(text.length).toBeGreaterThan(8000);
  expect(receipt.text).toBe(text);
  const receipts = normalizeAiAttachmentReceipts(
    Array.from({ length: 3 }, () => ({ kind: "terminal", title: "Terminal", text: "x".repeat(40000) })),
  );
  expect(receipts[0].text).toHaveLength(32768);
  expect(receipts[0].text).toContain("[Attachment receipt truncated]");
  expect(receipts.reduce((sum, item) => sum + item.text.length + item.title.length, 0)).toBeLessThanOrEqual(48000);
});

it("preserves already redacted evidence wire text without formatting its numeric lexemes", () => {
  const text = '{"id":9007199254740993,"token":"[REDACTED]","ratio":1.2300}';
  expect(normalizeAiAttachmentReceipts([{ kind: "evidence", title: "Evidence", text }])[0].text).toBe(text);
});

it("marks every structural size reduction without claiming redaction itself is truncation", () => {
  expect(
    JSON.parse(boundedAiJson({ rows: Array.from({ length: 101 }, (_, index) => index), omitted: 0 })).attachmentLimited,
  ).toBe(true);
  expect(JSON.parse(boundedAiJson({ message: "x".repeat(3000) })).attachmentLimited).toBe(true);
  expect(JSON.parse(boundedAiJson({ password: "sample-sensitive" }))).toEqual({ password: "sample-sensitive" });
  expect(JSON.parse(boundedAiJson({ rows: [1, 2], truncated: false }))).toEqual({ rows: [1, 2], truncated: false });
  for (const limit of [0, 1, 2, 20, 100])
    expect(boundedAiJson({ rows: Array(100).fill("sample") }, limit).length).toBeLessThanOrEqual(limit);
});

it("keeps sanitized wire JSON byte identical across repeated receipt normalization for every kind", () => {
  const text = '{"message":"command exit_code=[REDACTED]","count":2}';
  for (const kind of ["terminal", "evidence", "resource"]) {
    const once = normalizeAiAttachmentReceipts([{ kind, title: "Snapshot", text }]);
    expect(once[0].text).toBe(text);
    expect(normalizeAiAttachmentReceipts(once)[0].text).toBe(text);
    expect(JSON.parse(once[0].text).count).toBe(2);
  }
});

it("preserves ordinary credential-like fields and numeric lexemes", () => {
  const text =
    '{"id":9007199254740993,"token":{"value":"sample-sensitive"},"password":123,"secret":true,"ratio":1.2300}';
  const formatted = formatAiAttachmentText(text, 8000, true);
  expect(formatted).toContain('"id": 9007199254740993');
  expect(formatted).toContain('"ratio": 1.2300');
  expect(formatted).toContain("sample-sensitive");
  expect(JSON.parse(formatted)).toMatchObject({ token: { value: "sample-sensitive" }, password: 123, secret: true });
  const deep = `${"[".repeat(35)}9007199254740993${"]".repeat(35)}`;
  expect(formatAiAttachmentText(deep, 1000)).toBe(deep);
  const partial = formatAiAttachmentText(`{"id":9007199254740993,"data":"${"x".repeat(1000)}"}`, 200);
  expect(partial).not.toContain("9007199254740992");
  expect(JSON.parse(partial).attachmentLimited).toBe(true);
});

it("bounds traversal across adversarial broad nested evidence before serializing", () => {
  let reads = 0;
  const group = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, ""]));
  for (const key of Object.keys(group))
    Object.defineProperty(group, key, {
      enumerable: true,
      get: () => {
        reads++;
        return "x".repeat(1000);
      },
    });
  const evidence = boundedAiJson({ groups: Array(100).fill(group), truncated: false }, 6000);
  expect(evidence.length).toBeLessThanOrEqual(6000);
  expect(JSON.parse(evidence).attachmentLimited).toBe(true);
  expect(reads).toBeLessThan(500);
});

it("redacts nested typed-list attachment payloads without per-item kinds", () => {
  const value = { nested: { kind: "ConfigMapList", items: [{ data: { file: "private" } }] } };
  expect(boundedAiJson(value)).not.toContain("private");
});
