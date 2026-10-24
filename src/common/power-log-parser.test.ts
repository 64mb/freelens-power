import { describe, expect, it } from "vitest";
import { LogLineDecoder, parseLogLine } from "./power-log-parser";

const source = { namespace: "demo", pod: "worker", podUid: "pod-1", container: "app" };
describe("Power Logs parser", () => {
  it.each([
    [10, "trace"],
    [20, "debug"],
    [30, "info"],
    [40, "warn"],
    [50, "error"],
    [60, "fatal"],
  ])("recognizes numeric Pino level %i as %s without guessing from message text", (value, level) => {
    const result = parseLogLine(JSON.stringify({ level: value, msg: "error counter updated" }), source);
    expect(result.level).toBe(level);
    expect(result.message).toBe("error counter updated");
    expect(JSON.parse(result.fieldsJson!).level).toBe(value);
  });
  it.each([0, 15, 35, 70, -10, 30.5])("does not assign a standard Pino level to custom value %s", (level) => {
    expect(parseLogLine(JSON.stringify({ level, msg: "request completed" }), source).level).toBe("unknown");
  });
  it("parses nanosecond timestamp and structured message without markup interpretation", () => {
    const result = parseLogLine(
      '2026-01-01T12:00:00.123456789Z {"level":"WARNING","msg":"<script>text</script>","value":3}',
      source,
    );
    expect(result.timestamp).toBe(Date.parse("2026-01-01T12:00:00.123Z"));
    expect(result.level).toBe("warn");
    expect(result.message).toBe("<script>text</script>");
    expect(JSON.parse(result.fieldsJson!).value).toBe(3);
  });
  it("preserves malformed text and strips terminal escapes", () => {
    expect(parseLogLine("\u001b[31mERROR broken {\u001b[0m", source)).toMatchObject({
      level: "error",
      message: "ERROR broken {",
      fieldsJson: null,
    });
    expect(parseLogLine("ordinary text", source).level).toBe("unknown");
  });
  it("decodes split Unicode, CRLF and final partial lines", () => {
    const decoder = new LogLineDecoder();
    const bytes = Buffer.from("hello 🌍\r\nsecond\nlast");
    expect(decoder.push(bytes.subarray(0, 8))).toEqual([]);
    expect(decoder.push(bytes.subarray(8))).toEqual(["hello 🌍", "second"]);
    expect(decoder.push(new Uint8Array(), true)).toEqual(["last"]);
  });
  it.each([
    '"'.repeat(32768),
    JSON.stringify({ message: "a".repeat(32700) }),
    "🌍".repeat(24000),
  ])("keeps the entire escaped record within the IPC byte budget", (line) => {
    const result = parseLogLine(line, {
      ...source,
      pod: "p".repeat(253),
      podUid: "u".repeat(253),
      container: "c".repeat(253),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
    expect(result.message).not.toContain("\ufffd");
    if (result.fieldsJson !== null) expect(() => JSON.parse(result.fieldsJson!)).not.toThrow();
    if (line.startsWith("🌍") || line.startsWith('"')) expect(result.message).toContain("[truncated]");
  });
  it("drops oversized lines and resumes at the next newline", () => {
    const decoder = new LogLineDecoder();
    expect(decoder.push(`${"x".repeat(70000)}\nok\n`)).toEqual(["ok"]);
    expect(decoder.truncated).toBe(true);
  });
});
