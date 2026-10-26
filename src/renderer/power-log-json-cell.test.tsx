// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { formatDateTime } from "../common/date-time";
import { MockTooltip, tooltipText } from "./native-tooltip.test-utils";
import { LogJsonCell } from "./power-log-json-cell";
import { formatJsonLiteral } from "./power-log-json-fields";

const mocks = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.writeText } }));
const Icon = ({ material }: { material: string }) => <span data-icon={material} />;
afterEach(() => {
  cleanup();
  mocks.writeText.mockReset();
});

it.each([
  '{"a":1,"b":true,"c":null}',
  '[1,"two",false]',
  ' \n {"nested":[1,2]}\n',
])("highlights object and array JSON in a compact preview: %s", (value) => {
  const { container, getByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  expect(container.querySelector(".power-log-json")?.textContent).toBe(JSON.stringify(JSON.parse(value)));
  expect(container.querySelector("[data-token]")).not.toBeNull();
  expect(tooltipText(getByRole("button", { name: "Copy JSON" }))).toBe("Copy JSON");
  expect(container.querySelector('[data-icon="content_copy"]')).not.toBeNull();
});

it.each([
  null,
  "NULL",
  "plain text",
  "123",
  "true",
  '"text"',
  "{broken}",
  "[1,]",
])("preserves nonstructured cells without a copy action: %s", (value) => {
  const { container, queryByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  expect(container.textContent).toBe(value ?? "NULL");
  expect(queryByRole("button")).toBeNull();
  expect(container.querySelector(".power-log-json")).toBeNull();
});

it("retains message highlighting for plain SQL messages", () => {
  const { container } = render(<LogJsonCell value="GET /health" message Icon={Icon} />);
  expect(container.querySelector('[data-log-token="http-method"]')?.textContent).toBe("GET");
});

it.each([
  "msg",
  "custom_message",
  "anything",
])("highlights recognizable patterns in any plain text column: %s", (column) => {
  const value = "GET /health HTTP/1.1 503 550e8400-e29b-41d4-a716-446655440000";
  const { container } = render(<LogJsonCell value={value} column={column} Icon={Icon} />);
  expect(container.textContent).toBe(value);
  expect(container.querySelector('[data-log-token="http-method"]')?.textContent).toBe("GET");
  expect(container.querySelector('[data-log-token="http-status"]')?.textContent).toBe("503");
  expect(container.querySelector('[data-log-token="uuid"]')?.textContent).toBe("550e8400-e29b-41d4-a716-446655440000");
});

it.each([
  "level",
  "Level",
  "LEVEL",
  "severity",
  "loglevel",
  "LOG_LEVEL",
  "levelname",
  "level_name",
  "severityText",
  "SEVERITY_TEXT",
  "@l",
  "log.level",
])("normalizes textual severity labels in recognized columns: %s", (column) => {
  const { container } = render(<LogJsonCell value="debug" rawValue="debug" column={column} Icon={Icon} />);
  expect(container.querySelector('.power-logs-level-label[data-level="debug"]')?.textContent).toBe("DEBUG");
});

it.each([
  ["level", 30, "info"],
  ["LEVEL", 30, "info"],
  ["levelno", 10, "debug"],
  ["LEVELNO", 30, "warn"],
  ["severityNumber", 9, "info"],
  ["SEVERITY_NUMBER", 9, "info"],
])("uses the original numeric severity scale for %s=%i", (column, rawValue, level) => {
  const { container } = render(
    <LogJsonCell value={String(rawValue)} rawValue={rawValue} column={column} Icon={Icon} />,
  );
  expect(container.querySelector(`.power-logs-level-label[data-level="${level}"]`)?.textContent).toBe(String(rawValue));
});

it.each([
  ["level", "30"],
  ["levelno", "10"],
  ["severityNumber", "9"],
  ["level", "not a level"],
  ["custom", "debug"],
  ["custom", 30],
  ["level", 99],
])("does not guess a severity for ambiguous values in %s: %s", (column, rawValue) => {
  const { container } = render(
    <LogJsonCell value={String(rawValue)} rawValue={rawValue} column={column} Icon={Icon} />,
  );
  expect(container.querySelector(".power-logs-level-label")).toBeNull();
  expect(container.textContent).toBe(String(rawValue));
});

it("escapes JSON markup and escaped quotes", () => {
  const value = JSON.stringify({ '<img src="x">': '<script>alert("x")</script>' });
  const { container } = render(<LogJsonCell value={value} Icon={Icon} />);
  expect(container.querySelector(".power-log-json")?.textContent).toBe(value);
  expect(container.querySelector("img, script")).toBeNull();
});

it("copies the complete raw JSON while bounding the preview", () => {
  const value = JSON.stringify({ long: "x".repeat(10000) }, null, 2);
  const { container, getByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  expect(container.querySelector(".power-log-json")?.textContent?.length).toBe(2049);
  fireEvent.click(getByRole("button", { name: "Copy JSON" }));
  expect(mocks.writeText).toHaveBeenCalledWith(formatJsonLiteral(value));
  expect(getByRole("status").textContent).toBe("Copied");
  expect(container.querySelector('[data-icon="check"]')).not.toBeNull();
});

it("keeps click and keyboard copy activation from opening the SQL row", () => {
  const rowClick = vi.fn();
  const rowKey = vi.fn();
  const { container, getByRole } = render(
    <table>
      <tbody>
        <tr onClick={rowClick} onKeyDown={rowKey}>
          <td>
            <LogJsonCell value='{"a":1}' Icon={Icon} />
          </td>
        </tr>
      </tbody>
    </table>,
  );
  const button = getByRole("button", { name: "Copy JSON" });
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyUp(button, { key: "Enter" });
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: " " });
  fireEvent.keyUp(button, { key: " " });
  fireEvent.click(button);
  expect(rowClick).not.toHaveBeenCalled();
  expect(rowKey).not.toHaveBeenCalled();
  expect(mocks.writeText).toHaveBeenCalledTimes(2);
  fireEvent.click(container.querySelector(".power-log-json")!);
  expect(rowClick).toHaveBeenCalledTimes(1);
});

it("reports clipboard failures and resets feedback when the cell changes", () => {
  mocks.writeText.mockImplementationOnce(() => {
    throw new Error("clipboard unavailable");
  });
  const { getByRole, container, rerender } = render(<LogJsonCell value='{"a":1}' Icon={Icon} />);
  fireEvent.click(getByRole("button", { name: "Copy JSON" }));
  expect(getByRole("status").textContent).toBe("Unable to copy JSON");
  expect(tooltipText(getByRole("button"))).toBe("Unable to copy JSON");
  expect(container.querySelector('[data-icon="check"]')).toBeNull();
  rerender(<LogJsonCell value="[]" Icon={Icon} />);
  expect(getByRole("status").textContent).toBe("");
  fireEvent.click(getByRole("button"));
  expect(getByRole("status").textContent).toBe("Copied");
});

it("preserves raw numeric spellings and duplicate keys while disabling ambiguous field actions", () => {
  const value = ' { "n": 9007199254740993, "n": 1e999, "s": "a b" } ';
  const { container, getByRole, queryByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  expect(container.querySelector("pre")?.textContent).toBe('{"n":9007199254740993,"n":1e999,"s":"a b"}');
  expect(container.querySelector("pre [tabindex]")).toBeNull();
  fireEvent.mouseEnter(container.querySelector('[data-token="key"]')!);
  expect(queryByRole("toolbar")).toBeNull();
  fireEvent.click(getByRole("button", { name: "Copy JSON" }));
  expect(mocks.writeText).toHaveBeenCalledWith(formatJsonLiteral(value));
});

it("keeps only full JSON copying in table previews, including truncated values", () => {
  const value = JSON.stringify({ long: "x".repeat(4000) });
  const { container, getByRole, queryByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  fireEvent.mouseEnter(container.querySelector('[data-token="key"]')!);
  expect(queryByRole("toolbar")).toBeNull();
  expect(container.querySelector("pre [tabindex]")).toBeNull();
  fireEvent.click(getByRole("button", { name: "Copy JSON" }));
  expect(mocks.writeText).toHaveBeenCalledWith(formatJsonLiteral(value));
});

vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Component: { Tooltip: (props: any) => <MockTooltip {...props} /> } },
}));

it("formats numeric timestamps like live logs without changing the raw row value", () => {
  const value = Date.UTC(2026, 0, 1, 12, 34, 56);
  const { container } = render(<LogJsonCell value={String(value)} rawValue={value} column="timestamp" Icon={Icon} />);
  expect(container.querySelector(".power-logs-cell")?.textContent).toBe(formatDateTime(value).slice(-8));
  expect(tooltipText(container.querySelector(".power-logs-cell")!)).toContain(String(value));
});
