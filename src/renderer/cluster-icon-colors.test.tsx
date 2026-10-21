// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { IconColorPicker, MATCHING_ICON_COLORS } from "./cluster-icon-colors";

afterEach(cleanup);

it("offers eight matching colors and grouped Power, Freelens and Material palettes", () => {
  const change = vi.fn();
  render(<IconColorPicker label="Outline" value="#b49aff" onChange={change} />);
  expect(MATCHING_ICON_COLORS).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "Outline" }));
  expect(within(screen.getByRole("group", { name: "Power" })).getAllByRole("button")).toHaveLength(8);
  expect(within(screen.getByRole("group", { name: "Freelens" })).getAllByRole("button")).toHaveLength(5);
  expect(within(screen.getByRole("group", { name: "Material" })).getAllByRole("button")).toHaveLength(19);
  const swatches = ["Power", "Freelens", "Material"].flatMap((name) =>
    within(screen.getByRole("group", { name }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")!.split(" ").at(-1)),
  );
  expect(new Set(swatches).size).toBe(swatches.length);
  expect(screen.getByRole("button", { name: "Freelens Default #00a7a0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Material Indigo #3f51b5" }));
  expect(change).toHaveBeenCalledWith("#3f51b5");
  expect(screen.queryByRole("group", { name: "Outline palette" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outline" }));
});

it("captures Escape with an earlier parent document listener and keeps the parent open", () => {
  let paletteOpen = false;
  const closeParent = vi.fn();
  const parentEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!paletteOpen) closeParent();
  };
  document.addEventListener("keydown", parentEscape, true);
  try {
    render(
      <IconColorPicker
        label="Glyph"
        value="#b49aff"
        onChange={() => {}}
        onOpenChange={(next) => {
          paletteOpen = next;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Glyph" }));
    expect(paletteOpen).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(closeParent).not.toHaveBeenCalled();
    expect(paletteOpen).toBe(false);
    expect(screen.queryByRole("group", { name: "Glyph palette" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Glyph" }), { key: "Escape" });
    expect(closeParent).toHaveBeenCalledOnce();
  } finally {
    document.removeEventListener("keydown", parentEscape, true);
  }
});

it("dismisses on outside pointer events and honors disabling and retained colors", () => {
  const change = vi.fn();
  const opened = vi.fn();
  const view = render(<IconColorPicker label="Label color" value="#b49aff" onChange={change} onOpenChange={opened} />);
  fireEvent.click(screen.getByRole("button", { name: "Label color" }));
  fireEvent.pointerDown(document.body);
  expect(opened).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Label color" }));
  expect(screen.queryByLabelText("Label color custom color")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Material Blue #2196f3" }));
  expect(change).toHaveBeenCalledWith("#2196f3");
  view.rerender(
    <IconColorPicker label="Label color" value="#123456" onChange={change} disabled onOpenChange={opened} />,
  );
  expect(screen.getByRole("button", { name: "Label color" }).getAttribute("disabled")).not.toBeNull();
  expect(screen.queryByRole("group", { name: "Label color palette" })).toBeNull();
  expect(screen.getByText("#123456")).toBeTruthy();
});
