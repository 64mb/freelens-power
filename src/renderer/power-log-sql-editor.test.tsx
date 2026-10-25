// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SqlEditor, tokenizeSql } from "./power-log-sql-editor";

afterEach(cleanup);

it("preserves SQL text and recognizes lexical contexts without highlighting inside quotes or comments", () => {
  const sql =
    "SELECT UPPER(msg), json_extract(fieldsJson, '$.msg'), strftime('%H', timestamp), 42 FROM logs -- SELECT 7\nWHERE msg = 'it''s SELECT' AND \"FROM\" = `key` /* WHERE */";
  const tokens = tokenizeSql(sql);
  expect(tokens.map((token) => token.text).join("")).toBe(sql);
  expect(tokens.filter((token) => token.kind === "function").map((token) => token.text)).toEqual([
    "UPPER",
    "json_extract",
    "strftime",
  ]);
  expect(tokens.filter((token) => token.kind === "string").map((token) => token.text)).toContain("'it''s SELECT'");
  expect(tokens.filter((token) => token.kind === "comment").map((token) => token.text)).toEqual([
    "-- SELECT 7\n",
    "/* WHERE */",
  ]);
  expect(tokens.filter((token) => token.kind === "identifier").map((token) => token.text)).toEqual(['"FROM"', "`key`"]);
});

it("bounds highlighting work and keeps the full remaining text intact", () => {
  for (const sql of ["SELECT ".repeat(20000), "x ".repeat(40000), "'unterminated SELECT", "/* unterminated SELECT"]) {
    const tokens = tokenizeSql(sql);
    expect(tokens.map((token) => token.text).join("")).toBe(sql);
    expect(tokens.length).toBeLessThanOrEqual(10000);
  }
});

it("keeps an accessible native editor, renders safe text and forwards bounded edits", () => {
  const onChange = vi.fn();
  const value = "SELECT '<img src=x onerror=alert(1)>'";
  const { container } = render(
    <>
      <label htmlFor="query">SQL query</label>
      <SqlEditor id="query" value={value} onChange={onChange} />
    </>,
  );
  const input = screen.getByRole("textbox", { name: "SQL query" }) as HTMLTextAreaElement;
  expect(input.value).toBe(value);
  expect(input.maxLength).toBe(65536);
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(container.querySelector("pre")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("pre")?.textContent).toBe(value);
  expect(container.querySelector("img")).toBeNull();
  fireEvent.change(input, { target: { value: "x".repeat(70000) } });
  expect(onChange).toHaveBeenCalledWith("x".repeat(65536));
});

it("synchronizes highlight scrolling after scroll events and value updates", () => {
  const { container, rerender } = render(<SqlEditor id="query" value="SELECT 1" onChange={() => {}} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  const pre = container.querySelector("pre") as HTMLPreElement;
  input.scrollTop = 20;
  input.scrollLeft = 8;
  fireEvent.scroll(input);
  expect([pre.scrollTop, pre.scrollLeft]).toEqual([20, 8]);
  input.scrollTop = 40;
  rerender(<SqlEditor id="query" value="SELECT 2" onChange={() => {}} />);
  expect(pre.scrollTop).toBe(40);
});

it("selects only the query on triple click and leaves single clicks untouched", () => {
  const bubble = vi.fn();
  render(
    <div onClick={bubble}>
      <SqlEditor id="query" value="SELECT message FROM logs" onChange={() => {}} />
    </div>,
  );
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.click(input, { detail: 1 });
  expect(bubble).toHaveBeenCalledTimes(1);
  bubble.mockClear();
  fireEvent.mouseDown(input, { detail: 3 });
  fireEvent.click(input, { detail: 3 });
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  expect(bubble).not.toHaveBeenCalled();
});
