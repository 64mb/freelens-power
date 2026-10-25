import { expect, it } from "vitest";
import { messageTokens } from "./power-log-message-tokens";

function highlighted(text: string) {
  return messageTokens(text).map((token) => [token.kind, text.slice(token.start, token.end), token.statusClass]);
}

it.each([
  ["https://example.com/GET?q=TRACE&elapsed=3ms", "url"],
  ["http://example.com:8080/path", "url"],
  ["trace_id=123456789abcdef0123456789abcdef0", "trace-id"],
  ["traceId=123456789ABCDEF0123456789ABCDEF0", "trace-id"],
  ["span_id=123456789abcdef0", "trace-id"],
  ["spanId=123456789abcdef0", "trace-id"],
  ["traceparent=00-123456789abcdef0123456789abcdef0-123456789abcdef0-01", "trace-id"],
  ["192.0.2.1:443", "address"],
  ["[2001:db8::1]:65535", "address"],
  ["client_ip=2001:db8::1", "address"],
  ["remote_addr=192.0.2.1", "address"],
  ["HTTP/1.1 503", "http-status"],
  ["http.response.status_code=201", "http-status"],
  ['"statusCode": 404', "http-status"],
  ["1ns 2us 3µs 4μs 5ms 0.1s", "duration"],
])("recognizes explicit token %s", (text, kind) => {
  const values = highlighted(text);
  expect(values.length).toBeGreaterThan(0);
  expect(values.every((token) => token[0] === kind)).toBe(true);
});

it.each([
  "200 status=200 status_code=600 http_status=099 statusCode=2000",
  "trace_id=00000000000000000000000000000000 span_id=0000000000000000",
  "trace_id=1234 123456789abcdef0123456789abcdef0",
  "traceparent=01-123456789abcdef0123456789abcdef0-123456789abcdef0-01",
  "traceparent=00-123456789ABCDEF0123456789abcdef0-123456789abcdef0-01",
  "traceparent=00-00000000000000000000000000000000-123456789abcdef0-01",
  "traceparent=00-123456789abcdef0123456789abcdef0-0000000000000000-01",
  "192.0.2.999:80 192.0.2.1:65536 [2001:db8:::1]:80 ip=999.0.0.1",
  "0ms -2ms +2ms 3milliseconds latency1ms 1ms_suffix 1ms2",
  "xGET GET_suffix éGET foo.trace_id_extra=123456789abcdef0123456789abcdef0",
  "https://bad:999999/GET?x=TRACE&elapsed=3ms",
])("leaves uncertain values plain: %s", (text) => {
  expect(highlighted(text)).toEqual([]);
});

it("classifies each HTTP status family", () => {
  expect(
    messageTokens("http_status=100 status_code=201 statusCode=302 HTTP/1.1 404 http.status_code=503").map(
      (token) => token.statusClass,
    ),
  ).toEqual(["1", "2", "3", "4", "5"]);
});

it("bounds scanning and nodes for pathological records", () => {
  const start = performance.now();
  expect(messageTokens(`https://${"x".repeat(1000000)}/GET 5ms`)).toEqual([]);
  expect(messageTokens(`${" ".repeat(65536)}GET`)).toEqual([]);
  expect(messageTokens("9".repeat(65536))).toEqual([]);
  expect(messageTokens("1.".repeat(32768))).toEqual([]);
  expect(messageTokens("GET ".repeat(10000))).toHaveLength(80);
  expect(performance.now() - start).toBeLessThan(1000);
});
