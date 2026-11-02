// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startNodeBulkSelection } from "./node-bulk-selection";

const prefix = "menu-actions-for-kube-object-menu-for-";
const nodes = [
  { uid: "uid-a", name: "full-node-a" },
  { uid: "uid-b", name: "full-node-b" },
  { uid: "uid-hidden", name: "unseen-node" },
];
let controller: ReturnType<typeof startNodeBulkSelection> | undefined;
const mount = () => {
  document.body.innerHTML = `<div class="Nodes"><div class="Table"><div class="TableHead"></div><div class="TableRow" id="${prefix}uid-a">truncated…</div><div class="TableRow" id="${prefix}uid-b">truncated…</div></div></div>`;
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const inputs = () => [...document.querySelectorAll<HTMLInputElement>("input")];
afterEach(() => {
  controller?.stop();
  document.body.innerHTML = "";
});

it("selects only rendered exact UIDs and maintains the header mixed state", () => {
  mount();
  const onChange = vi.fn();
  controller = startNodeBulkSelection({ getNodes: () => nodes, onChange });
  inputs()[1].click();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0]]);
  expect(inputs()[0].indeterminate).toBe(true);
  expect(inputs()[0].getAttribute("aria-checked")).toBe("mixed");
  inputs()[0].click();
  expect(onChange).toHaveBeenLastCalledWith(nodes.slice(0, 2));
  expect(inputs()[0].checked).toBe(true);
  inputs()[0].click();
  expect(onChange).toHaveBeenLastCalledWith([]);
});

it("retains manual selection across virtual rows and clears on filter input", async () => {
  mount();
  const onChange = vi.fn();
  controller = startNodeBulkSelection({ getNodes: () => nodes, onChange });
  inputs()[1].click();
  document.querySelector<HTMLElement>(".TableRow")!.id = `${prefix}uid-hidden`;
  inputs()[1].click();
  await flush();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0]]);
  inputs()[1].click();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0], nodes[2]]);
  document.querySelector(".TableRow")!.remove();
  await flush();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0], nodes[2]]);
  const filter = document.createElement("input");
  document.querySelector(".Nodes")!.append(filter);
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});

it("stops detail clicks and restores native DOM on stop, context change and unmount", async () => {
  mount();
  let context = "one";
  const click = vi.fn();
  const onChange = vi.fn();
  const onTable = vi.fn();
  document.querySelector(".TableRow")!.addEventListener("click", click);
  controller = startNodeBulkSelection({ getNodes: () => nodes, getContext: () => context, onChange, onTable });
  inputs()[1].click();
  expect(click).not.toHaveBeenCalled();
  context = "two";
  controller.refresh();
  expect(onChange).toHaveBeenLastCalledWith([]);
  inputs()[1].click();
  document.querySelector(".Nodes")!.remove();
  await flush();
  expect(onChange).toHaveBeenLastCalledWith([]);
  expect(onTable).toHaveBeenLastCalledWith(null);
  mount();
  await flush();
  expect(inputs()).toHaveLength(3);
  controller.stop();
  expect(inputs()).toHaveLength(0);
});

it("changes only visible selection with the header after scrolling", () => {
  mount();
  const onChange = vi.fn();
  controller = startNodeBulkSelection({ getNodes: () => nodes, onChange });
  inputs()[1].click();
  document.querySelector<HTMLElement>(".TableRow")!.id = `${prefix}uid-hidden`;
  controller.refresh();
  expect(inputs()[0].checked).toBe(false);
  expect(inputs()[0].indeterminate).toBe(false);
  inputs()[0].click();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0], nodes[1], nodes[2]]);
  inputs()[0].click();
  expect(onChange).toHaveBeenLastCalledWith([nodes[0]]);
});

it("uses native checkbox markup with focusable inputs and cleans up mixed styling", () => {
  mount();
  controller = startNodeBulkSelection({ getNodes: () => nodes, onChange: vi.fn() });
  const input = inputs()[1];
  const label = input.parentElement!;
  expect(label.matches("label.Checkbox.flex.align-center")).toBe(true);
  expect(label.querySelector("i.box.flex.align-center")?.getAttribute("aria-hidden")).toBe("true");
  expect(input.style.display).toBe("block");
  input.focus();
  expect(document.activeElement).toBe(input);
  input.click();
  expect(inputs()[0].parentElement?.classList.contains("mixed")).toBe(true);
  const style = document.head.querySelector("style[data-power-node-selection]");
  expect(style?.textContent).toContain(":focus-visible");
  expect(style?.textContent).toContain(".Checkbox.mixed");
  inputs()[0].click();
  expect(inputs()[0].parentElement?.classList.contains("mixed")).toBe(false);
  controller.stop();
  expect(style?.isConnected).toBe(false);
});

it("clears programmatic search changes without input events and keeps scroll selections", async () => {
  vi.useFakeTimers();
  try {
    mount();
    const search = document.createElement("input");
    search.value = "node";
    document.querySelector(".Nodes")!.prepend(search);
    const onChange = vi.fn();
    controller = startNodeBulkSelection({ getNodes: () => nodes, onChange });
    inputs()[2].click();
    document.querySelector<HTMLElement>(".TableRow")!.id = `${prefix}uid-hidden`;
    await flush();
    expect(onChange).toHaveBeenLastCalledWith([nodes[0]]);
    search.value = "";
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenLastCalledWith([]);
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("clears URL and native filter reset transitions independently of virtual row changes", async () => {
  mount();
  const filters = document.createElement("div");
  filters.className = "PageFiltersList";
  filters.innerHTML = '<span class="filter" title="search"><span class="value">node</span></span>';
  document.querySelector(".Nodes")!.prepend(filters);
  const onChange = vi.fn();
  controller = startNodeBulkSelection({ getNodes: () => nodes, onChange });
  inputs()[1].click();
  filters.querySelector(".value")!.textContent = "other";
  await flush();
  expect(onChange).toHaveBeenLastCalledWith([]);
  inputs()[1].click();
  filters.replaceChildren();
  await flush();
  expect(onChange).toHaveBeenLastCalledWith([]);
  inputs()[1].click();
  const previousUrl = window.location.href;
  window.history.pushState({}, "", "?search=other");
  document.body.click();
  expect(onChange).toHaveBeenLastCalledWith([]);
  inputs()[1].click();
  window.history.replaceState({}, "", "?search=back");
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(onChange).toHaveBeenLastCalledWith([]);
  window.history.replaceState({}, "", previousUrl);
});
