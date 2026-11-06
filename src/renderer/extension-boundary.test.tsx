// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionBoundary } from "./extension-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("contains registration render failures while keeping host content available", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("private render error");
  }
  render(
    <>
      <span>native host content</span>
      <ExtensionBoundary>
        <Broken />
      </ExtensionBoundary>
    </>,
  );
  expect(screen.getByText("native host content")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Freelens Power could not display this view");
  expect(document.body.textContent).not.toContain("private render error");
});
