import { describe, expect, it } from "vitest";
import { createDoubleShift, matchResources, type SearchResource } from "./resource-search-model";

const items: SearchResource[] = [
  { kind: "Pod", name: "api-server", namespace: "staging", labels: { app: "backend" }, path: "/pods/api-server" },
  { kind: "Service", name: "api", namespace: "production", labels: { app: "backend" }, path: "/services/api" },
];
const key = (name: string, type = "keydown", repeat = false) => ({
  key: name,
  type,
  repeat,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
});
describe("resource search", () => {
  it("matches every token across names, namespaces, kinds and label selectors", () => {
    expect(matchResources(items, "POD staging APP=backend")).toEqual([items[0]]);
    expect(matchResources(items, "api production")).toEqual([items[1]]);
    expect(matchResources(items, "pod production")).toEqual([]);
  });
  it("accepts two separate bare Shift taps within 400ms", () => {
    const detect = createDoubleShift();
    expect(detect(key("Shift"), 100)).toBe(false);
    detect(key("Shift", "keyup"), 150);
    expect(detect(key("Shift"), 400)).toBe(true);
  });
  it("rejects repeats, held Shift, intervening keys, modifiers and slow taps", () => {
    const detect = createDoubleShift();
    expect(detect(key("Shift"), 100)).toBe(false);
    expect(detect(key("Shift", "keydown", true), 120)).toBe(false);
    expect(detect(key("Shift"), 130)).toBe(false);
    detect(key("Shift", "keyup"), 140);
    detect(key("A"), 150);
    expect(detect(key("Shift"), 200)).toBe(false);
    detect(key("Shift", "keyup"), 220);
    expect(detect(key("Shift"), 700)).toBe(false);
    detect(key("Shift", "keyup"), 710);
    expect(detect({ ...key("Shift"), ctrlKey: true }, 750)).toBe(false);
  });
});
it("ranks exact names, name prefixes and exact kinds before label-only matches", () => {
  const candidates: SearchResource[] = [
    { kind: "DaemonSet", name: "agent", labels: { service: "worker" }, path: "/agent" },
    { kind: "Service", name: "backend", labels: {}, path: "/backend" },
    { kind: "Pod", name: "service-worker", labels: {}, path: "/prefix" },
    { kind: "Pod", name: "service", labels: {}, path: "/exact" },
  ];
  expect(matchResources(candidates, "service").map((resource) => resource.path)).toEqual([
    "/exact",
    "/prefix",
    "/backend",
    "/agent",
  ]);
});
it("rejects Shift chords while another key remains held", () => {
  const detect = createDoubleShift();
  detect(key("a"), 100);
  expect(detect(key("Shift"), 150)).toBe(false);
  detect(key("Shift", "keyup"), 180);
  expect(detect(key("Shift"), 200)).toBe(false);
  detect(key("Shift", "keyup"), 220);
  detect(key("a", "keyup"), 230);
  expect(detect(key("Shift"), 250)).toBe(false);
  detect(key("Shift", "keyup"), 260);
  expect(detect(key("Shift"), 300)).toBe(true);
});
it("uses physical keys when releasing a letter whose case changed with Shift", () => {
  const detect = createDoubleShift();
  detect({ ...key("a"), code: "KeyA" }, 100);
  detect(key("Shift"), 110);
  detect({ ...key("A", "keyup"), code: "KeyA" }, 120);
  detect(key("Shift", "keyup"), 130);
  expect(detect(key("Shift"), 200)).toBe(false);
  detect(key("Shift", "keyup"), 210);
  expect(detect(key("Shift"), 300)).toBe(true);
});
it("recovers after Command release when macOS omits a chord keyup", () => {
  const detect = createDoubleShift();
  detect({ ...key("Meta"), metaKey: true, code: "MetaLeft" }, 100);
  detect({ ...key("k"), metaKey: true, code: "KeyK" }, 110);
  detect({ ...key("Meta", "keyup"), code: "MetaLeft" }, 120);
  expect(detect(key("Shift"), 200)).toBe(false);
  detect(key("Shift", "keyup"), 210);
  expect(detect(key("Shift"), 300)).toBe(true);
});
it("finds discovered short aliases without reading resource payloads", () => {
  const item = {
    kind: "ConfigMap",
    name: "settings",
    namespace: "default",
    labels: {},
    aliases: ["cm"],
    path: "/api/v1/namespaces/default/configmaps/settings",
  };
  expect(matchResources([item], "cm")).toEqual([item]);
});
