// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { forwardHotbarShortcut, startHotbarFrameShortcuts } from "./hotbar-frame-shortcuts";

const origin = "https://example.renderer.freelens.app";
const data = { channel: "freelens-power:hotbar-shortcut", code: "Digit2", metaKey: false, ctrlKey: false };
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function setup(frameOrigin = origin) {
  document.body.innerHTML = `<div id="lens-views"><iframe id="cluster-frame-example" src="${frameOrigin}"></iframe></div>`;
  const frame = document.querySelector("iframe")!;
  frame.focus();
  const callback = vi.fn();
  const stop = startHotbarFrameShortcuts(callback);
  stops.push(stop);
  const send = (options: MessageEventInit = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: frameOrigin, source: frame.contentWindow, ...options }),
    );
  return { frame, callback, stop, send };
}

it("accepts only the focused native cluster frame and removes its listener on cleanup", () => {
  const { callback, send, stop } = setup();
  send();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ code: "Digit2", metaKey: false, ctrlKey: false });
  stop();
  send();
  expect(callback).toHaveBeenCalledOnce();
});

it("rejects external origins, other windows, mismatched frame origins and non-native frames", () => {
  const { frame, callback, send } = setup();
  send({ origin: "https://example.com" });
  send({ origin: "https://example.renderer.freelens.app.example.com" });
  send({ origin: "http://example.renderer.freelens.app" });
  send({ source: window });
  send({ origin: "https://other.renderer.freelens.app" });
  frame.id = "widget-frame";
  send();
  expect(callback).not.toHaveBeenCalled();
});

it("rejects background and hidden frames including hidden ancestors", () => {
  const { frame, callback, send } = setup();
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  send();
  frame.focus();
  frame.hidden = true;
  send();
  frame.hidden = false;
  frame.parentElement!.classList.add("hidden");
  send();
  frame.parentElement!.classList.remove("hidden");
  frame.parentElement!.style.display = "none";
  send();
  expect(callback).not.toHaveBeenCalled();
});

it.each([
  null,
  { ...data, code: "Digit0" },
  { ...data, code: "KeyA" },
  { ...data, metaKey: "true" },
  { ...data, metaKey: true, ctrlKey: true },
  { ...data, channel: "other" },
  { ...data, altKey: true },
])("rejects malformed or expanded payloads: %j", (payload) => {
  const { callback, send } = setup();
  send({ data: payload });
  expect(callback).not.toHaveBeenCalled();
});

function childContext(childOrigin = origin, referrer = "https://renderer.freelens.app/") {
  const postMessage = vi.fn();
  const context = {
    location: { origin: childOrigin },
    document: { referrer },
    parent: { postMessage },
  } as unknown as Window;
  return { context, postMessage };
}

it("forwards a narrow digit payload only to the trusted parent origin", () => {
  const { context, postMessage } = childContext();
  const event = new KeyboardEvent("keydown", { code: "Digit2", metaKey: true });
  expect(forwardHotbarShortcut(event, context)).toBe(true);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ ...data, metaKey: true }, "https://renderer.freelens.app");
  expect(event.defaultPrevented).toBe(false);
});

it.each([
  ["https://example.com", "https://renderer.freelens.app/"],
  [origin, "https://example.com/"],
  [origin, "https://renderer.freelens.app.example.com/"],
  [origin, ""],
])("does not bridge an untrusted child or parent: %s %s", (child, referrer) => {
  const { context, postMessage } = childContext(child, referrer);
  expect(forwardHotbarShortcut(new KeyboardEvent("keydown", { code: "Digit2" }), context)).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});

it.each([
  { altKey: true },
  { shiftKey: true },
  { repeat: true },
  { isComposing: true },
  { metaKey: true, ctrlKey: true },
])("does not forward unsupported keyboard states: %j", (options) => {
  const { context, postMessage } = childContext();
  expect(forwardHotbarShortcut(new KeyboardEvent("keydown", { code: "Digit2", ...options }), context)).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});

it("does not forward an already handled event or install a parent listener inside a child", () => {
  const { context, postMessage } = childContext();
  const event = new KeyboardEvent("keydown", { code: "Digit2", cancelable: true });
  event.preventDefault();
  expect(forwardHotbarShortcut(event, context)).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
  expect(startHotbarFrameShortcuts(vi.fn(), context)).toBeTypeOf("function");
});

it("accepts native renderer proxy ports while rejecting a different source port", () => {
  const { callback, send } = setup(`${origin}:41237`);
  send({ origin: `${origin}:41238` });
  send({ origin });
  expect(callback).not.toHaveBeenCalled();
  send();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ code: "Digit2", metaKey: false, ctrlKey: false });
});

it("forwards from a native cluster proxy port to the exact parent proxy origin", () => {
  const { context, postMessage } = childContext(`${origin}:41237`, "https://renderer.freelens.app:41237/cluster");
  expect(forwardHotbarShortcut(new KeyboardEvent("keydown", { code: "Digit2" }), context)).toBe(true);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith(data, "https://renderer.freelens.app:41237");
});
