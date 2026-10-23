import { describe, expect, it } from "vitest";
import { groupTimelineEntries } from "./timeline-groups";

import type { TimelineEntry } from "./resource-diagnostics";

const entry = (id: string, count: number, time: string): TimelineEntry => ({
  id,
  count,
  time,
  reason: "BackOff",
  message: "Retrying",
  certainty: "reported",
  objectUid: id,
});
describe("timeline warning groups", () => {
  it("uses latest evidence and avoids counting cumulative snapshots twice", () => {
    const groups = groupTimelineEntries(
      [entry("a", 3, "2026-01-01"), entry("a", 5, "2026-01-02"), entry("b", 2, "2026-01-03")],
      () => "application",
      (entry) => entry.objectUid!,
    );
    expect(groups[0].count).toBe(7);
    expect(groups[0].latest.objectUid).toBe("b");
    expect(groups[0].affected).toEqual(["a", "b"]);
    expect(groups[0].entries).toHaveLength(3);
  });
  it("keeps different applications and reasons separate", () => {
    const a = entry("a", 1, "2026-01-01");
    expect(
      groupTimelineEntries(
        [a, { ...a, id: "b" }, { ...a, reason: "Failed" }],
        (item) => item.id,
        () => "pod",
      ),
    ).toHaveLength(3);
  });
});

it("separates distinct causes for one application and groups whitespace-equivalent messages", () => {
  const base = entry("a", 2, "2026-01-01");
  const groups = groupTimelineEntries(
    [
      { ...base, message: "Insufficient cpu" },
      { ...base, id: "b", message: "Insufficient   cpu" },
      { ...base, id: "c", message: "Unbound persistent volume claims" },
    ],
    () => "same-application",
    () => "pod",
  );
  expect(groups).toHaveLength(2);
  expect(groups.find((group) => group.entries.length === 2)?.count).toBe(4);
});
