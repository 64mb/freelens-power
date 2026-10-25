// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LogJsonCell } from "./power-log-json-cell";

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
  expect(getByRole("button", { name: "Copy JSON" }).title).toBe("Copy JSON");
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
  expect(mocks.writeText).toHaveBeenCalledWith(value);
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
  expect(getByRole("button").title).toBe("Unable to copy JSON");
  expect(container.querySelector('[data-icon="check"]')).toBeNull();
  rerender(<LogJsonCell value="[]" Icon={Icon} />);
  expect(getByRole("status").textContent).toBe("");
  fireEvent.click(getByRole("button"));
  expect(getByRole("status").textContent).toBe("Copied");
});

it("preserves raw numeric spellings and duplicate keys while disabling ambiguous field actions", () => {
  const value = ' { "n": 9007199254740993, "n": 1e999, "s": "a b" } ';
  const { container, getByRole, queryByRole } = render(<LogJsonCell value={value} Icon={Icon} onFilter={vi.fn()} />);
  expect(container.querySelector("pre")?.textContent).toBe('{"n":9007199254740993,"n":1e999,"s":"a b"}');
  expect(container.querySelector("pre [tabindex]")).toBeNull();
  fireEvent.mouseEnter(container.querySelector('[data-token="key"]')!);
  expect(queryByRole("toolbar")).toBeNull();
  fireEvent.click(getByRole("button", { name: "Copy JSON" }));
  expect(mocks.writeText).toHaveBeenCalledWith(value);
});

it("uses the complete field value behind a truncated syntax preview", () => {
  const value = JSON.stringify({ long: "x".repeat(4000) });
  const onFilter = vi.fn();
  const { container, getByRole } = render(<LogJsonCell value={value} Icon={Icon} onFilter={onFilter} />);
  fireEvent.mouseEnter(container.querySelector('[data-token="key"]')!);
  fireEvent.click(getByRole("button", { name: "Include value" }));
  expect(onFilter).toHaveBeenCalledWith({ path: ["long"], operator: "eq", value: "x".repeat(4000) });
  fireEvent.click(getByRole("button", { name: "Copy value" }));
  expect(mocks.writeText).toHaveBeenCalledWith("x".repeat(4000));
});

it("copies exact unsafe integer and nested numeric literals from complete field source", () => {
  const value =
    '{"n":9007199254740993,"container":{"n":9007199254740993,"large":1e999,"tail":"' + "x".repeat(4000) + '"}}';
  const { container, getByRole } = render(<LogJsonCell value={value} Icon={Icon} />);
  const keys = container.querySelectorAll('[data-token="key"]');
  fireEvent.mouseEnter(keys[0]);
  fireEvent.click(getByRole("button", { name: "Copy value" }));
  expect(mocks.writeText).toHaveBeenLastCalledWith("9007199254740993");
  fireEvent.mouseEnter(keys[1]);
  fireEvent.click(getByRole("button", { name: "Copy value" }));
  expect(mocks.writeText).toHaveBeenLastCalledWith(value.slice(value.indexOf('{"n"', 1), -1));
});
