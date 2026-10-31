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
  const { container, getByRole } = render(
    <LogJson text={text} Icon={Icon} onFilter={vi.fn()} onToggleColumn={vi.fn()} />,
  );
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
  for (const name of ["Copy value", "Include value", "Exclude value", "Show field as column"]) {
    const button = getByRole("button", { name });
    expect(button.title).toBe("");
    expect(button.style.width).toBe("20px");
    expect(button.style.minHeight).toBe("0px");
    expect(button.style.minWidth).toBe("0px");
    expect(button.style.background).toBe("transparent");
    expect(button.style.borderWidth).toBe("0px");
    expect(button.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(name);
  }
  expect(
    getByRole("button", { name: "Show field as column" }).querySelector("[data-icon]")?.getAttribute("data-icon"),
  ).toBe("visibility");
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
  expect(getByRole("button", { name: "Copy value" }).hasAttribute("title")).toBe(false);
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

it("follows a different JSON line before the pointer leaves its token for whitespace", () => {
  vi.useFakeTimers();
  try {
    const filter = vi.fn();
    const { container, getByRole } = render(<LogJson text={'{\n  "first": 1,\n  "second": 2\n}'} onFilter={filter} />);
    const keys = container.querySelectorAll<HTMLElement>('[data-token="key"]');
    keys.forEach((key, index) => {
      vi.spyOn(key, "getBoundingClientRect").mockReturnValue({
        left: 30,
        right: 100,
        top: 80 + index * 20,
        bottom: 100 + index * 20,
        height: 20,
      } as DOMRect);
    });
    fireEvent.mouseEnter(keys[0]);
    fireEvent.mouseLeave(keys[0], { relatedTarget: keys[1] });
    fireEvent.mouseEnter(keys[1]);
    fireEvent.mouseLeave(keys[1], { relatedTarget: container.querySelector("pre") });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(getByRole("toolbar").style.top).toBe("100px");
    fireEvent.click(getByRole("button", { name: "Include value" }));
    expect(filter).toHaveBeenLastCalledWith({ path: ["second"], value: 2, operator: "eq" });
  } finally {
    vi.useRealTimers();
  }
});

it("follows a wrapped value on another line without using the full token height as row tolerance", () => {
  const filter = vi.fn();
  const { container, getByRole } = render(
    <LogJson text={'{\n  "first": 1,\n  "second": "wrapped value"\n}'} onFilter={filter} />,
  );
  const first = container.querySelector<HTMLElement>('[data-token="key"]')!;
  const wrapped = container.querySelector<HTMLElement>('[data-token="string"]')!;
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue({
    left: 30,
    right: 100,
    top: 80,
    bottom: 100,
    height: 20,
  } as DOMRect);
  vi.spyOn(wrapped, "getBoundingClientRect").mockReturnValue({
    left: 30,
    right: 150,
    top: 100,
    bottom: 160,
    height: 60,
  } as DOMRect);
  fireEvent.mouseEnter(first);
  fireEvent.mouseLeave(first);
  fireEvent.mouseEnter(wrapped);
  fireEvent.mouseLeave(wrapped);
  expect(getByRole("toolbar").style.top).toBe("100px");
  fireEvent.click(getByRole("button", { name: "Include value" }));
  expect(filter).toHaveBeenLastCalledWith({ path: ["second"], value: "wrapped value", operator: "eq" });
});

it("places actions after the last wrapped visual line including its trailing comma", () => {
  const { container, getByRole } = render(
    <LogJson text={'{\n  "id": "wrapped value",\n  "other": 1\n}'} onFilter={vi.fn()} />,
  );
  const key = container.querySelector<HTMLElement>('[data-token="key"]')!;
  vi.spyOn(key, "getBoundingClientRect").mockReturnValue({ top: 80, right: 100, height: 14 } as DOMRect);
  const createRange = vi.spyOn(document, "createRange").mockReturnValue({
    setStart: vi.fn(),
    setEnd: vi.fn(),
    getClientRects: () => [
      { top: 80, right: 280, width: 200, height: 14 },
      { top: 100, right: 180, width: 100, height: 14 },
      { top: 100, right: 188, width: 8, height: 14 },
    ],
  } as unknown as Range);
  try {
    fireEvent.mouseEnter(key);
    expect(getByRole("toolbar").style.left).toBe("192px");
    expect(getByRole("toolbar").style.top).toBe("97px");
  } finally {
    createRange.mockRestore();
  }
});

it("toggles nested fields as columns with exact typed paths and pressed state", () => {
  const onToggleColumn = vi.fn();
  const text = '{"a.b":[{"0":null}],"object":{},"array":[]}';
  const { container, getByRole, rerender } = render(
    <LogJson text={text} onToggleColumn={onToggleColumn} columnPaths={[["a.b", "0", "0"]]} />,
  );
  fireEvent.focus(container.querySelector('[data-token="literal"]')!);
  const show = getByRole("button", { name: "Show field as column" });
  expect(show.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(show);
  expect(onToggleColumn).toHaveBeenLastCalledWith(["a.b", 0, "0"]);
  rerender(<LogJson text={text} onToggleColumn={onToggleColumn} columnPaths={[["a.b", 0, "0"]]} />);
  const hide = getByRole("button", { name: "Hide field column" });
  expect(hide.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(hide);
  expect(onToggleColumn).toHaveBeenLastCalledWith(["a.b", 0, "0"]);
  const keys = container.querySelectorAll('[data-token="key"]');
  for (const [index, path] of [
    [2, ["object"]],
    [3, ["array"]],
  ] as const) {
    fireEvent.focus(keys[index]);
    fireEvent.click(getByRole("button", { name: "Show field as column" }));
    expect(onToggleColumn).toHaveBeenLastCalledWith(path);
  }
});

it("omits column controls without a callback in read-only and copy-only JSON", () => {
  const Icon = () => <span />;
  const { container, queryByRole, getByRole, rerender } = render(<LogJson text='{"value":1}' />);
  expect(container.querySelector("[tabindex]")).toBeNull();
  rerender(<LogJson text='{"value":1}' Icon={Icon} columnPaths={[["value"]]} />);
  fireEvent.focus(container.querySelector('[data-token="key"]')!);
  expect(getByRole("button", { name: "Copy value" })).toBeTruthy();
  expect(queryByRole("button", { name: /field.*column/ })).toBeNull();
});

it.each([
  '{"value":1,"value":2}',
  '{"value":[1,',
  "[".repeat(10000) + "0" + "]".repeat(10000),
])("keeps column actions disabled for ambiguous or invalid JSON", (text) => {
  const { container, queryByRole } = render(<LogJson text={text} onToggleColumn={vi.fn()} />);
  expect(container.querySelector("pre [tabindex]")).toBeNull();
  fireEvent.mouseEnter(container.querySelector("pre span")!);
  expect(queryByRole("toolbar")).toBeNull();
});

it.each([
  [false, false, 20],
  [true, false, 64],
  [false, true, 42],
  [true, true, 86],
])("fits the actual action count inside the wrapper", (filter, column, width) => {
  const Icon = () => <span />;
  const { container, getByRole } = render(
    <LogJson
      text='{"value":1}'
      Icon={Icon}
      onFilter={filter ? vi.fn() : undefined}
      onToggleColumn={column ? vi.fn() : undefined}
    />,
  );
  const key = container.querySelector<HTMLElement>('[data-token="key"]')!;
  const wrapper = container.querySelector<HTMLElement>(".power-log-json-fields")!;
  vi.spyOn(key, "getBoundingClientRect").mockReturnValue({ right: 2500, top: 80, height: 20 } as DOMRect);
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({ right: 320 } as DOMRect);
  fireEvent.focus(key);
  expect(getByRole("toolbar").style.left).toBe(`${320 - Number(width)}px`);
});

it.each([
  false,
  true,
])("reports field copy feedback through the native icon tooltip without a visible status (fails: %s)", (fails) => {
  const Icon = ({ material, tooltip }: { material: string; tooltip?: string }) => (
    <span data-icon={material} data-tooltip={tooltip} />
  );
  const text = '{"first":"original","second":"next"}';
  const { container, getByRole, queryByRole } = render(<LogJson text={text} Icon={Icon} />);
  const values = container.querySelectorAll('[data-token="string"]');
  fireEvent.focus(values[0]);
  const copy = getByRole("button", { name: "Copy value" });
  expect(copy.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe("Copy value");
  if (fails)
    mocks.writeText.mockImplementationOnce(() => {
      throw new Error("private clipboard diagnostic");
    });
  fireEvent.click(copy);
  expect(mocks.writeText).toHaveBeenLastCalledWith("original");
  const feedback = fails ? "Copy failed" : "Copied";
  expect(copy.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(fails ? "content_copy" : "check");
  expect(copy.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(feedback);
  const status = getByRole("status");
  expect(status.textContent).toBe(feedback);
  expect(status.style.width).toBe("1px");
  expect(status.style.height).toBe("1px");
  expect(status.style.clipPath).toBe("inset(50%)");
  expect(status.style.overflow).toBe("hidden");
  expect(container.textContent).not.toContain("private clipboard diagnostic");
  expect(container.querySelector("pre")?.textContent).toBe(text);
  fireEvent.focus(values[1]);
  expect(queryByRole("status")).toBeNull();
  expect(getByRole("button", { name: "Copy value" }).querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(
    "content_copy",
  );
  expect(
    getByRole("button", { name: "Copy value" }).querySelector("[data-tooltip]")?.getAttribute("data-tooltip"),
  ).toBe("Copy value");
  expect(container.querySelector("pre")?.textContent).toBe(text);
});

it("shows a check glyph after copying when native icons are unavailable", () => {
  const { container, getByRole } = render(<LogJson text='{"value":"raw"}' onFilter={vi.fn()} />);
  fireEvent.focus(container.querySelector('[data-token="string"]')!);
  const copy = getByRole("button", { name: "Copy value" });
  expect(copy.textContent).toBe("⧉");
  fireEvent.click(copy);
  expect(copy.textContent).toBe("✓");
  expect(getByRole("status").textContent).toBe("Copied");
});
