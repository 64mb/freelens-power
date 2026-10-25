// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LogMessage } from "./power-log-message";

afterEach(cleanup);

it.each([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
])("highlights standalone HTTP method %s without changing the message", (method) => {
  const text = `[Express ${method}] Request completed [3b4aaa28-8e60-44a5-982b-5d1da37884be]`;
  const { container } = render(<LogMessage text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelector('[data-log-token="http-method"]')?.textContent).toBe(method);
  expect(container.querySelector('[data-log-token="uuid"]')?.textContent).toBe("3b4aaa28-8e60-44a5-982b-5d1da37884be");
});

it("preserves ASCII spacing, markup and unmatched words as plain text", () => {
  const text = "  |    |\t<img src=x> get TARGET GETTING POSTED\n  |____|";
  const { container } = render(<LogMessage text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-log-token]")).toBeNull();
});

it("recognizes uppercase UUIDs and updates when the message changes", () => {
  const { container, rerender } = render(<LogMessage text="[3B4AAA28-8E60-44A5-982B-5D1DA37884BE]" />);
  expect(container.querySelector('[data-log-token="uuid"]')).not.toBeNull();
  rerender(<LogMessage text="plain text" />);
  expect(container.textContent).toBe("plain text");
  expect(container.querySelector("[data-log-token]")).toBeNull();
});

it("bounds highlighted nodes while preserving the whole long message", () => {
  const text = "GET ".repeat(1000);
  const { container } = render(<LogMessage text={text} />);
  expect(container.querySelectorAll("[data-log-token]").length).toBe(80);
  expect(container.textContent).toBe(text);
});

it("escapes markup around explicit tokens and preserves every character", () => {
  const text = "  <script>GET</script>\tHTTP/1.1 503\nhttps://example.com/GET?q=TRACE&time=2ms <img src=x> 2ms ";
  const { container } = render(<LogMessage text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelector("script, img")).toBeNull();
  expect(container.querySelector('[data-log-token="url"]')?.textContent).toBe(
    "https://example.com/GET?q=TRACE&time=2ms",
  );
  expect(container.querySelector('[data-log-token="http-status"]')?.getAttribute("data-status-class")).toBe("5");
  expect(container.querySelectorAll('[data-log-token="http-method"]')).toHaveLength(1);
});

it("preserves the unscanned suffix of an oversized record", () => {
  const text = `GET ${" ".repeat(65536)}POST\n<script>unchanged</script>`;
  const { container } = render(<LogMessage text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelectorAll("[data-log-token]")).toHaveLength(1);
  expect(container.querySelector("script")).toBeNull();
});
