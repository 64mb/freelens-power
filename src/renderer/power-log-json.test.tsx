// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.writeText } }));

import { LogJson } from "./power-log-json";

it("highlights JSON types while preserving escaped content and treating markup as text", () => {
  const text = JSON.stringify(
    {
      'escaped"key': "<img src=x onerror=alert(1)>",
      number: -1.2e30,
      enabled: true,
      absent: null,
      nested: [false, "30", "a\\b"],
    },
    null,
    2,
  );
  const { container } = render(<LogJson text={text} />);
  expect(container.textContent).toBe(text);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[data-token="key"]')?.textContent).toBe('"escaped\\"key"');
  expect(container.querySelector('[data-token="string"]')?.textContent).toContain("<img");
  expect(container.querySelector('[data-token="number"]')?.textContent).toBe("-1.2e+30");
  expect([...container.querySelectorAll('[data-token="literal"]')].map((el) => el.textContent)).toEqual([
    "true",
    "null",
    "false",
  ]);
});

it("filters literal paths and copies complete typed values without changing pre text", () => {
  const onFilter = vi.fn();
  const text = '{"a.b":{"quoted\\"key":[null,"raw",{"x":1}]}}';
  const { container, getByRole, rerender } = render(<LogJson text={text} onFilter={onFilter} />);
  const fields = container.querySelectorAll<HTMLElement>("pre [tabindex]");
  fireEvent.mouseEnter(fields[0]);
  fireEvent.click(getByRole("button", { name: "Copy value" }));
  expect(mocks.writeText).toHaveBeenLastCalledWith('{"quoted\\"key":[null,"raw",{"x":1}]}');
  const absent = container.querySelector<HTMLElement>('[data-token="literal"]')!;
  fireEvent.focus(absent);
  fireEvent.click(getByRole("button", { name: "Include value" }));
  fireEvent.click(getByRole("button", { name: "Exclude value" }));
  expect(onFilter.mock.calls.map(([filter]) => filter)).toEqual([
    { path: ["a.b", 'quoted"key', 0], operator: "eq", value: null },
    { path: ["a.b", 'quoted"key', 0], operator: "neq", value: null },
  ]);
  expect(container.querySelector("pre")?.textContent).toBe(text);
  fireEvent.mouseEnter(getByRole("toolbar"));
  expect(getByRole("toolbar")).toBeTruthy();
  rerender(<LogJson text='{"next":true}' onFilter={onFilter} />);
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
});

it("contains keyboard and click events and reports clipboard errors", () => {
  const outer = vi.fn();
  const { container, getByRole } = render(
    <div onClick={outer} onKeyDown={outer}>
      <LogJson text='{"value":"raw"}' onFilter={vi.fn()} />
    </div>,
  );
  fireEvent.focus(container.querySelector('[data-token="string"]')!);
  mocks.writeText.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  fireEvent.click(getByRole("button", { name: "Copy value" }));
  expect(getByRole("status").textContent).toBe("Copy failed");
  fireEvent.keyDown(getByRole("button", { name: "Copy value" }), { key: "Enter" });
  expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(getByRole("button", { name: "Copy value" }), { key: "Escape" });
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
});
