import { describe, expect, it } from "vitest";
import { sanitizeAiTerminalSnapshot } from "./ai-terminal-context";

const snapshot = (text: string) => sanitizeAiTerminalSnapshot({ text, capturedAt: "2026-01-01T00:00:00.000Z" });
describe("terminal attachment boundary", () => {
  it("redacts multiline environment assignments before selecting the tail", () => {
    const result = snapshot('EXAMPLE="' + "private value\n".repeat(350) + '"\nready');
    expect(result?.text).toBe("EXAMPLE=[REDACTED]\nready");
  });
  it("redacts credential formats, private keys and terminal escapes independently", () => {
    const result = snapshot(
      "\u001b[31mready\u001b[0m\nAuthorization: Bearer sensitive-value\nhttps://person:credential@example.invalid\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    );
    expect(result?.text).toContain("ready");
    for (const secret of ["sensitive-value", "credential", "private-material", "\u001b"])
      expect(result?.text).not.toContain(secret);
  });
  it("redacts quoted credential fields and command line credentials", () => {
    const result = snapshot(
      '"token": "sensitive-value"\nlogin --password "another value"\nlogin --api-key=private-value',
    );
    for (const value of ["sensitive-value", "another value", "private-value"])
      expect(result?.text).not.toContain(value);
  });
  it("masks unquoted shell continuation values before selecting the tail", () => {
    const result = snapshot("export EXAMPLE=first\\\nsecond-secret\\\nthird-secret\nready");
    expect(result?.text).toBe("export EXAMPLE=[REDACTED]\nready");
  });
  it("masks kubectl credential fields and YAML environment values including blocks", () => {
    const result = snapshot(
      "client-key-data: private-key\nclient-certificate-data: private-cert\ntoken: private-token\npassword: private-password\nenv:\n  - name: EXAMPLE\n    value: |\n      private-first\n      private-second\nready: yes",
    );
    for (const secret of [
      "private-key",
      "private-cert",
      "private-token",
      "private-password",
      "private-first",
      "private-second",
    ])
      expect(result?.text).not.toContain(secret);
    expect(result?.text).toContain("ready: yes");
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
