import { beforeEach, expect, it } from "vitest";
import { clearDiagnosticsStates, readDiagnosticsState, saveDiagnosticsState } from "./diagnostics-state";

beforeEach(clearDiagnosticsStates);
it("isolates per-cluster navigation preferences and defaults to warnings", () => {
  const initial = readDiagnosticsState("one");
  expect(initial.warningOnly).toBe(true);
  saveDiagnosticsState("one", {
    ...initial,
    filter: "sample",
    tab: "Timeline",
    expanded: ["sample/app"],
    scrollTop: 123,
  });
  expect(readDiagnosticsState("one").scrollTop).toBe(123);
  expect(readDiagnosticsState("two").filter).toBe("");
  expect(Object.keys(readDiagnosticsState("one"))).not.toContain("snapshot");
});
