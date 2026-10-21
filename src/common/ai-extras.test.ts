import { describe, expect, it } from "vitest";
import { referencedAiResources } from "./ai-extras";

const worker = { apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" };

describe("answer-grounded resource references", () => {
  it("keeps only exact identities mentioned in the final answer", () => {
    const other = { ...worker, name: "worker-extra" };
    expect(referencedAiResources("The first pod is `worker`", [worker, other])).toEqual([worker]);
    expect(referencedAiResources("worker-extra is running", [worker])).toEqual([]);
    expect(referencedAiResources("The first pod is worker.", [worker])).toEqual([worker]);
    expect(referencedAiResources("invented is running", [worker])).toEqual([]);
    expect(referencedAiResources("other/worker is running", [worker])).toEqual([]);
    expect(referencedAiResources("No resource found", [worker])).toEqual([]);
  });

  it("requires qualified identities when names are ambiguous", () => {
    const other = { ...worker, namespace: "other" };
    expect(referencedAiResources("worker is running in default", [worker, other])).toEqual([]);
    expect(referencedAiResources("default/worker is running", [worker, other])).toEqual([worker]);
    expect(referencedAiResources("not-default/worker is running", [worker, other])).toEqual([]);
    expect(referencedAiResources("default/worker", [worker, { ...worker, kind: "Service" }])).toEqual([]);
  });
});

it("caps references at five after removing unrelated candidates", () => {
  const mentioned = Array.from({ length: 8 }, (_, index) => ({ ...worker, name: `worker-${index}` }));
  const unrelated = Array.from({ length: 8 }, (_, index) => ({ ...worker, name: `unrelated-${index}` }));
  const answer = mentioned.map((reference) => reference.name).join(", ");
  expect(referencedAiResources(answer, [...unrelated, ...mentioned])).toEqual(mentioned.slice(0, 5));
});
