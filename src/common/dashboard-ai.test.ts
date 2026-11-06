// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { readDashboardDocument } from "../browser/dashboard-ai";
import { dashboardAiUrl, dashboardAiWidgets, dashboardDocumentReadScript } from "./dashboard-ai";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("reads bounded visible text only inside the configured widget", () => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  document.body.innerHTML =
    '<aside>Other widget</aside><main><p>Healthy</p><div hidden>Hidden secret</div><div style="display:none">Hidden CSS</div><input value="password"><textarea>Typed secret</textarea><div contenteditable="true">Editable secret</div><script>secret()</script></main>';
  expect(readDashboardDocument("main")).toEqual({ text: "Healthy", truncated: false });
});

it("bounds text and rejects missing configured selectors", () => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  document.body.textContent = "x".repeat(30000);
  const result = readDashboardDocument();
  expect(result.text).toHaveLength(24000);
  expect(result.truncated).toBe(true);
  expect(() => readDashboardDocument("#missing")).toThrow("unavailable");
  const selector = 'a[data-value="example\\\"),alert(1)//"]';
  expect(dashboardDocumentReadScript(selector)).toContain(`readDashboardDocument(${JSON.stringify(selector)})`);
});

it("masks URL credentials in AI context without changing configured URLs", () => {
  const raw = "https://reader:password@example.com/status?token=private&view=health";
  expect(dashboardAiUrl(raw)).not.toContain("password");
  expect(dashboardAiUrl(raw)).not.toContain("private");
  expect(dashboardAiUrl(raw)).toContain("view=health");
  expect(dashboardAiUrl("https://example.com/?signature=private&auth=private#access_token=private")).not.toContain(
    "private",
  );
});

it("exposes opaque widget aliases without leaking configured IDs", () => {
  expect(
    dashboardAiWidgets([
      { id: "card-credential-bearing-url", title: "Status", url: "https://example.com/status", size: "m" },
    ]),
  ).toEqual([{ id: "widget-1", title: "Status", url: "https://example.com/status" }]);
});
