// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.writeText } }));

import { LogJson } from "./power-log-json";

afterEach(cleanup);

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

it("shows plain icon controls on the hovered line with separate tooltips", () => {
  const text = '{"value":42}';
  const Icon = ({ material, tooltip }: { material: string; tooltip?: string }) => (
    <span data-icon={material} data-tooltip={tooltip} />
  );
  const { container, getByRole } = render(<LogJson text={text} Icon={Icon} onFilter={vi.fn()} />);
  const key = container.querySelector<HTMLElement>('[data-token="key"]')!;
  vi.spyOn(key, "getBoundingClientRect").mockReturnValue({
    left: 30,
    right: 100,
    top: 80,
    bottom: 100,
    height: 20,
  } as DOMRect);
  fireEvent.mouseEnter(key);
  const toolbar = getByRole("toolbar");
  expect(toolbar.style.top).toBe("80px");
  expect(toolbar.style.left).toBe("104px");
  expect(toolbar.style.background).toBe("transparent");
  for (const name of ["Copy value", "Include value", "Exclude value"]) {
    const button = getByRole("button", { name });
    expect(button.title).toBe("");
    expect(button.style.width).toBe("20px");
    expect(button.style.minHeight).toBe("0px");
    expect(button.style.minWidth).toBe("0px");
    expect(button.style.background).toBe("transparent");
    expect(button.style.borderWidth).toBe("0px");
    expect(button.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(name);
  }
  expect(container.querySelector("pre")?.textContent).toBe(text);
});

it("keeps icons open while the pointer crosses the gap to the toolbar", () => {
  vi.useFakeTimers();
  try {
    const { container, getByRole } = render(<LogJson text='{"value":42}' onFilter={vi.fn()} />);
    fireEvent.mouseEnter(container.querySelector('[data-token="key"]')!);
    const toolbar = getByRole("toolbar");
    fireEvent.mouseLeave(container.querySelector(".power-log-json-fields")!);
    fireEvent.mouseEnter(toolbar);
    vi.advanceTimersByTime(200);
    expect(getByRole("toolbar")).toBeTruthy();
    fireEvent.keyDown(getByRole("button", { name: "Copy value" }), { key: "Escape" });
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("clamps action icons inside the visible JSON wrapper for very long lines", () => {
  const { container, getByRole } = render(<LogJson text='{"value":42}' onFilter={vi.fn()} />);
  const key = container.querySelector<HTMLElement>('[data-token="key"]')!;
  const wrapper = container.querySelector<HTMLElement>(".power-log-json-fields")!;
  vi.spyOn(key, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 2500,
    top: 80,
    bottom: 100,
    height: 20,
  } as DOMRect);
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({ left: 20, right: 320, top: 60, bottom: 200 } as DOMRect);
  fireEvent.mouseEnter(key);
  expect(getByRole("toolbar").style.left).toBe("256px");
  expect(getByRole("toolbar").style.top).toBe("80px");
  expect(getByRole("button", { name: "Copy value" }).title).toBe("Copy value");
});

it("keeps the chosen compact JSON field while crossing other fields toward its actions", () => {
  vi.useFakeTimers();
  try {
    const filter = vi.fn();
    const { container, getByRole } = render(<LogJson text={'{"first":1,"second":2}'} onFilter={filter} />);
    const keys = container.querySelectorAll('[data-token="key"]');
    fireEvent.mouseEnter(keys[0]);
    fireEvent.mouseLeave(keys[0]);
    fireEvent.mouseEnter(keys[1]);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.mouseLeave(keys[1]);
    fireEvent.mouseEnter(getByRole("toolbar"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.click(getByRole("button", { name: "Include value" }));
    expect(filter).toHaveBeenLastCalledWith({ path: ["first"], value: 1, operator: "eq" });
    fireEvent.mouseEnter(keys[1]);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    fireEvent.click(getByRole("button", { name: "Include value" }));
    expect(filter).toHaveBeenLastCalledWith({ path: ["second"], value: 2, operator: "eq" });
  } finally {
    vi.useRealTimers();
  }
});
