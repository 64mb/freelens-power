// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
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
