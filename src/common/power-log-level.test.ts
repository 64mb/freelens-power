import { expect, it } from "vitest";
import { parseLogLine } from "./power-log-parser";

const source = { namespace: "demo", pod: "worker", podUid: "pod-1", container: "app" };

it.each([
  [{ LogLevel: "Information", Message: "request completed" }, "info"],
  [{ Level: "Warning", RenderedMessage: "request completed" }, "warn"],
  [{ "@t": "2026-01-01T00:00:00Z", "@l": "Verbose", "@m": "request completed" }, "trace"],
  [{ "@t": "2026-01-01T00:00:00Z", "@mt": "request completed" }, "info"],
  [{ "log.level": "ERROR", message: "request completed" }, "error"],
  [{ log: { level: "WARN" }, message: "request completed" }, "warn"],
  [{ level: 200, level_name: "INFO", message: "request completed" }, "info"],
  [{ level: 20, levelname: "INFO", message: "request completed" }, "info"],
  [{ levelno: 20, message: "request completed" }, "info"],
  [{ levelno: 40, message: "request completed" }, "error"],
  [{ severity_number: 20, body: "request completed" }, "error"],
  [{ SeverityNumber: 1, Body: "request completed" }, "trace"],
  [{ severityText: "Information", body: { stringValue: "request completed" } }, "info"],
  [{ level: "DEBUG", fields: { message: "request completed" }, target: "demo" }, "debug"],
  [{ level: "DPANIC", msg: "request completed" }, "error"],
  [{ text: "formatted log", record: { level: { name: "SUCCESS", no: 25 }, message: "request completed" } }, "info"],
])("recognizes explicit logger formats %#", (input, level) => {
  const record = parseLogLine(JSON.stringify(input), source);
  expect(record.level).toBe(level);
  expect(record.message).toBe("request completed");
  expect(JSON.parse(record.fieldsJson!)).toEqual(input);
});

it.each([0, 25, -1, 1.5, "17", null])("does not guess invalid OTel severity %s", (severityNumber) => {
  expect(parseLogLine(JSON.stringify({ severityNumber, body: "ERROR is part of the message" }), source).level).toBe(
    "unknown",
  );
});

it.each([
  ["[12:34:56 INF] request completed", "info"],
  ["2026-01-01 12:34:56,123 WARN request completed", "warn"],
  ["info: Demo.Worker[0] request completed", "info"],
  ["[DBG] request completed", "debug"],
  ['time=2026-01-01T00:00:00Z level=WARN msg="no error occurred"', "warn"],
  ['msg="text with level=ERROR" level=INFO', "info"],
  ["I1025 00:15:15.525108 1 worker.go:79] request completed", "info"],
  ["E1025 00:15:15.525108 1 worker.go:79] request completed", "error"],
  ["<14>1 2026-01-01T00:00:00Z host app 1 - - request completed", "info"],
])("recognizes explicit text header %s", (text, level) => {
  expect(parseLogLine(text, source).level).toBe(level);
});

it.each([
  "request completed without error",
  "counter for WARN was reset",
  'msg="level=ERROR"',
  'msg="unterminated level=ERROR',
  '{"level":"CUSTOM","message":"ERROR is not a header"}',
  '{"message":"ERROR is a message"}',
  '{"level":"constructor","message":"request completed"}',
  '{"LogLevel":4,"Message":"request completed"}',
  '{"severity":40,"message":"request completed"}',
  "warning threshold is configurable",
  "<999>1 invalid priority",
  "[worker warning] normal message",
])("does not infer severity from ambiguous text %s", (text) => {
  expect(parseLogLine(text, source).level).toBe("unknown");
});
