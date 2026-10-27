// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  bindHelmDiffWheel,
  createHelmHorizontalScroll,
  HelmCodeView,
  HelmRevisionDiff,
  openHelmDocumentFind,
} from "./helm-code-view";

const mocks = vi.hoisted(() => ({ models: [] as any[], props: [] as any[], copy: vi.fn(), lateMeasurements: false }));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.copy } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Icon: () => <span aria-hidden="true">copy</span>,
      Button: (props: any) => (
        <button disabled={props.disabled} onClick={props.onClick}>
          {props.label}
        </button>
      ),
      Checkbox: (props: any) => (
        <label>
          <input type="checkbox" checked={props.value} onChange={(event) => props.onChange(event.target.checked)} />
          {props.label}
        </label>
      ),
      MonacoEditor: (props: any) => {
        mocks.props.push(props);
        const previous = useRef<any>();
        const field = useRef<HTMLTextAreaElement>(null);
        const dimensions = useRef<{ value: string; width: number }>();
        useEffect(() => {
          const width =
            typeof props.style.width === "number" ? props.style.width : props.style.width === "100%" ? 400 : 399;
          const last = dimensions.current;
          dimensions.current = { value: props.value, width };
          if (!mocks.lateMeasurements || !last) return;
          if (last.width !== width) props.onDidLayoutChange?.({ width, contentWidth: width - 80 });
          if (last.value !== props.value)
            props.onDidContentSizeChange?.({ contentWidth: Math.max(width - 80, props.value.length * 8) });
        }, [props.value, props.style.width]);
        useEffect(() => {
          const model = { deltaDecorations: vi.fn(() => ["decoration"]), dispose: vi.fn(), isDisposed: () => false };
          mocks.models.push(model);
          if (previous.current) {
            field.current?.focus();
            const scroller = field.current?.closest("[data-scroll-host]");
            if (scroller) {
              scroller.scrollTop = 999;
              scroller.scrollLeft = 999;
            }
            props.onModelChange(model, previous.current);
          }
          previous.current = model;
        }, [props.id]);
        return (
          <textarea
            ref={field}
            aria-label={props.options.ariaLabel}
            value={props.value}
            readOnly={props.options.readOnly}
            data-language={props.language}
            onChange={(event) => props.onChange?.(event.target.value)}
          />
        );
      },
    },
  },
}));
afterEach(() => {
  cleanup();
  mocks.models.length = 0;
  mocks.props.length = 0;
  mocks.copy.mockReset();
  mocks.lateMeasurements = false;
});

it("updates native editor content and enforces read-only changes", async () => {
  const onChange = vi.fn();
  const view = render(<HelmCodeView value="replicas: 1" ariaLabel="Values" onChange={onChange} />);
  expect((screen.getByLabelText("Values") as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText("Values"), { target: { value: "replicas: 3" } });
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<HelmCodeView value="replicas: 2" ariaLabel="Values" readOnly={false} onChange={onChange} />);
  expect((screen.getByLabelText("Values") as HTMLTextAreaElement).value).toBe("replicas: 2");
  expect((screen.getByLabelText("Values") as HTMLTextAreaElement).readOnly).toBe(false);
  fireEvent.change(screen.getByLabelText("Values"), { target: { value: "replicas: 4" } });
  expect(onChange).toHaveBeenCalledWith("replicas: 4");
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mocks.models.length).toBe(2);
  for (const model of mocks.models) expect(model.dispose).toHaveBeenCalledOnce();
});

it("compares selected and current documents and refreshes highlights", () => {
  const view = render(
    <HelmRevisionDiff
      before="replicas: 1"
      after="replicas: 2"
      beforeLabel="Revision 1"
      afterLabel="Current revision 2"
    />,
  );
  expect(screen.getByText("+ 1 added lines")).toBeTruthy();
  expect(screen.getByText("− 1 removed lines")).toBeTruthy();
  expect((screen.getByLabelText("Revision 1") as HTMLTextAreaElement).value).toBe("replicas: 1");
  expect((screen.getByLabelText("Current revision 2") as HTMLTextAreaElement).value).toBe("replicas: 2");
  expect(
    mocks.models.some((model) =>
      model.deltaDecorations.mock.calls.some((call: any[]) =>
        call[1].some((decoration: any) => decoration.options.className === "helm-diff-line-added"),
      ),
    ),
  ).toBe(true);
  view.rerender(
    <HelmRevisionDiff
      before="replicas: 2"
      after="replicas: 2"
      beforeLabel="Revision 2"
      afterLabel="Current revision 2"
    />,
  );
  expect(screen.getByText("No changes between these revisions")).toBeTruthy();
});

it("keeps full documents visible when detailed comparison exceeds its bound", () => {
  const before = "a".repeat(1024 * 1024 + 1);
  render(<HelmRevisionDiff before={before} after="new" beforeLabel="Selected" afterLabel="Current" />);
  expect(screen.getByText(/Detailed comparison exceeds the size limit/)).toBeTruthy();
  expect((screen.getByLabelText("Selected") as HTMLTextAreaElement).value).toBe(before.slice(0, 256 * 1024));
  expect(screen.getByText(/Only the first 1000 lines and 262144 characters/)).toBeTruthy();
  expect((screen.getByLabelText("Current") as HTMLTextAreaElement).value).toBe("new");
});

it("preserves keyboard focus and ancestor scroll during the initial read-only model handoff", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const container = document.createElement("div");
  container.setAttribute("data-scroll-host", "");
  container.scrollTop = 37;
  container.scrollLeft = 12;
  document.body.append(container);
  const view = render(<HelmRevisionDiff before="old" after="new" beforeLabel="Selected" afterLabel="Current" />, {
    container,
  });
  expect(document.activeElement).toBe(trigger);
  expect(container.scrollTop).toBe(37);
  expect(container.scrollLeft).toBe(12);
  view.unmount();
  container.remove();
  trigger.remove();
});

it("does not leave a read-only editor focused when the page body held focus", () => {
  render(<HelmCodeView value="replicas: 1" ariaLabel="Read-only values" />);
  expect(document.activeElement).not.toBe(screen.getByLabelText("Read-only values"));
});

it("allows an explicitly opened writable editor to receive native focus", () => {
  render(<HelmCodeView value="replicas: 1" ariaLabel="Edit values" readOnly={false} />);
  expect(document.activeElement).toBe(screen.getByLabelText("Edit values"));
});

it("hides unrelated YAML by default and expands it with the native checkbox", () => {
  const before = Array.from({ length: 20 }, (_, index) => `key${index}: old`);
  const after = [...before];
  after[10] = "key10: new";
  const view = render(
    <HelmRevisionDiff
      before={before.join("\n")}
      after={after.join("\n")}
      beforeLabel={<b>Source version</b>}
      afterLabel={<b>Target version</b>}
    />,
  );
  expect(screen.getByText("7 unchanged lines hidden")).toBeTruthy();
  expect(screen.getByText("6 unchanged lines hidden")).toBeTruthy();
  expect(screen.getByText("Source version")).toBeTruthy();
  expect(mocks.props.some((props) => props.value.includes("key0:"))).toBe(false);
  const context = mocks.props.find((props) => props.value.startsWith("key7:"));
  expect(context.options.lineNumbers(1)).toBe("8");
  expect(context.options.scrollbar.vertical).toBe("hidden");
  const scroller = screen.getByLabelText("Comparison documents");
  scroller.scrollTop = 72;
  fireEvent.scroll(scroller);
  expect(scroller.scrollTop).toBe(72);
  expect(view.container.querySelectorAll(".helm-diff-scroll")).toHaveLength(1);
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(screen.queryByText(/unchanged lines hidden/)).toBeNull();
  expect(mocks.props.some((props) => props.value.includes("key0:"))).toBe(true);
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(screen.getByText("7 unchanged lines hidden")).toBeTruthy();
});

it("shows an explicit no-change state without mounting hidden document editors", () => {
  render(<HelmRevisionDiff before="same" after="same" beforeLabel="Source" afterLabel="Target" />);
  expect(screen.getByText("No changes between these revisions")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
});

it("forwards find through the accessible editor input and prevents recursive forwarding", () => {
  const view = render(<HelmCodeView value="document" />);
  const input = screen.getByRole("textbox");
  const keys = vi.fn((event: KeyboardEvent) => {
    expect(event.key).toBe("f");
    expect(event.ctrlKey || event.metaKey).toBe(true);
    expect(openHelmDocumentFind(view.container)).toBe(false);
    event.preventDefault();
  });
  input.addEventListener("keydown", keys);
  expect(openHelmDocumentFind(view.container)).toBe(true);
  expect(keys).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(input);
  input.removeEventListener("keydown", keys);
  expect(openHelmDocumentFind(view.container)).toBe(false);
  expect(openHelmDocumentFind(document.createElement("div"))).toBe(false);
});

it("disposes models from compact and full views when toggled and unmounted", async () => {
  const source = Array.from({ length: 20 }, (_, index) => `${index}`);
  const target = [...source];
  target[10] = "changed";
  const view = render(
    <HelmRevisionDiff before={source.join("\n")} after={target.join("\n")} beforeLabel="Before" afterLabel="After" />,
  );
  fireEvent.click(screen.getByLabelText("Show full documents"));
  fireEvent.click(screen.getByLabelText("Show full documents"));
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const model of mocks.models) expect(model.dispose).toHaveBeenCalledOnce();
});

it("searches the entire comparison from outside editors and reveals hidden original context", () => {
  const before = Array.from({ length: 30 }, (_, index) => `key${index}: value`);
  const after = [...before];
  after[10] = "first: changed";
  after[25] = "later: changed";
  const view = render(
    <HelmRevisionDiff before={before.join("\n")} after={after.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  expect(openHelmDocumentFind(view.container)).toBe(true);
  const find = screen.getByLabelText("Find in both documents");
  fireEvent.change(find, { target: { value: "changed" } });
  expect(screen.getByText("2 matches · Target line 11, column 8")).toBeTruthy();
  fireEvent.click(screen.getByText("Next match"));
  expect(screen.getByText("2 matches · Target line 26, column 8")).toBeTruthy();
  fireEvent.click(screen.getByText("Next match"));
  expect(screen.getByText("2 matches · Target line 11, column 8")).toBeTruthy();
  fireEvent.change(find, { target: { value: "key0:" } });
  expect(screen.getByText("2 matches · Source line 1, column 1")).toBeTruthy();
  expect(screen.getAllByText(/unchanged lines hidden/).length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Matching original document excerpt")).toBeTruthy();
  expect((screen.getByLabelText("Show full documents") as HTMLInputElement).checked).toBe(false);
  fireEvent.keyDown(find, { key: "Escape" });
  expect(screen.queryByLabelText("Find in both documents")).toBeNull();
});

it("intercepts editor find to search both originals instead of one chunk", () => {
  render(<HelmRevisionDiff before="old" after="new" beforeLabel="Source" afterLabel="Target" />);
  fireEvent.keyDown(screen.getByLabelText("Source"), { key: "f", ctrlKey: true });
  expect(screen.getByLabelText("Find in both documents")).toBeTruthy();
});

it("bounds native editor mounts for fragmented comparisons and reports the full-document fallback", () => {
  const before = Array.from({ length: 80 }, (_, index) => `key${index}`);
  const after = before.map((line, index) => (index % 2 ? line : `changed${index}`));
  render(
    <HelmRevisionDiff before={before.join("\n")} after={after.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  expect(screen.getByText(/Aligned comparison exceeds the display limit/)).toBeTruthy();
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  expect(mocks.models).toHaveLength(4);
});

it("closes comparison find from outside the pane and yields to visible menus", () => {
  const view = render(<HelmRevisionDiff before="old" after="new" beforeLabel="Source" afterLabel="Target" />);
  openHelmDocumentFind(view.container);
  const menu = document.createElement("div");
  menu.className = "Select__menu";
  document.body.append(menu);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByLabelText("Find in both documents")).toBeTruthy();
  menu.remove();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByLabelText("Find in both documents")).toBeNull();
  view.unmount();
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it("preserves find when an earlier overlay disappears during the same Escape event", () => {
  render(<HelmRevisionDiff before="old" after="new" beforeLabel="Source" afterLabel="Target" />);
  fireEvent.keyDown(screen.getByLabelText("Source"), { key: "f", ctrlKey: true });
  const menu = document.createElement("div");
  menu.className = "helm-release-actions-menu";
  document.body.append(menu);
  const dismissMenu = () => menu.remove();
  window.addEventListener("keydown", dismissMenu, true);
  fireEvent.keyDown(screen.getByLabelText("Find in both documents"), { key: "Escape" });
  expect(menu.isConnected).toBe(false);
  expect(screen.getByLabelText("Find in both documents")).toBeTruthy();
  window.removeEventListener("keydown", dismissMenu, true);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByLabelText("Find in both documents")).toBeNull();
});

it("keeps a three-edit long YAML comparison compact with a single vertical viewport", () => {
  const before = Array.from({ length: 363 }, (_, index) => `key${index}: unchanged`);
  const after = [...before];
  for (const index of [25, 180, 330]) after[index] = `key${index}: changed`;
  const view = render(
    <HelmRevisionDiff before={before.join("\n")} after={after.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  expect(screen.queryByText(/Aligned comparison exceeds/)).toBeNull();
  expect(screen.getByText("+ 3 added lines")).toBeTruthy();
  expect(screen.getByText("− 3 removed lines")).toBeTruthy();
  expect(screen.getByText("Both panes share vertical scrolling")).toBeTruthy();
  expect(view.container.querySelectorAll(".helm-diff-scroll")).toHaveLength(1);
  expect(screen.getAllByRole("textbox")).toHaveLength(18);
  expect(mocks.props.every((props) => props.options.scrollbar?.vertical === "hidden")).toBe(true);
});

it("uses the common vertical viewport for bounded-display and size-limit fallbacks", () => {
  const before = Array.from({ length: 80 }, (_, index) => `key${index}`);
  const after = before.map((line, index) => (index % 2 ? line : `changed${index}`));
  const view = render(
    <HelmRevisionDiff before={before.join("\n")} after={after.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  expect(screen.getByText(/Aligned comparison exceeds/)).toBeTruthy();
  expect(screen.getByText("Both panes share vertical scrolling")).toBeTruthy();
  expect(view.container.querySelectorAll(".helm-diff-scroll")).toHaveLength(1);
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  for (const props of mocks.props) {
    expect(props.options.scrollbar).toEqual({
      verticalScrollbarSize: 16,
      horizontalScrollbarSize: 15,
      vertical: "hidden",
      horizontal: "hidden",
      alwaysConsumeMouseWheel: false,
    });
    expect(props.style.height).toBe("100%");
  }
  const editors = view.container.querySelectorAll<HTMLElement>(".helm-code-view");
  expect(Array.from(editors).map((editor) => editor.style.height)).toEqual(["1454px", "1454px"]);
  mocks.props.length = 0;
  view.rerender(
    <HelmRevisionDiff
      before={"a".repeat(1024 * 1024 + 1)}
      after={"one\ntwo\nthree"}
      beforeLabel="Source"
      afterLabel="Target"
    />,
  );
  expect(screen.getByText(/Detailed comparison exceeds/)).toBeTruthy();
  expect(
    Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view")).map((editor) => editor.style.height),
  ).toEqual(["68px", "68px"]);
  expect(mocks.props.every((props) => props.options.scrollbar?.vertical === "hidden")).toBe(true);
});

it("bounds huge fallback rendering and copies the full original with retry after failure", () => {
  const before = Array.from({ length: 25000 }, (_, index) => `key${index}: value`).join("\n");
  const view = render(<HelmRevisionDiff before={before} after="target" beforeLabel="Source" afterLabel="Target" />);
  expect(screen.getByText(/Only the first 1000 lines and 262144 characters/)).toBeTruthy();
  const source = screen.getByLabelText("Source") as HTMLTextAreaElement;
  expect(source.value.split("\n")).toHaveLength(1000);
  expect(source.value).toBe(before.split("\n").slice(0, 1000).join("\n"));
  expect(
    Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view")).map((editor) => editor.style.height),
  ).toEqual(["18014px", "18014px"]);
  mocks.copy.mockImplementationOnce(() => {
    throw Error("clipboard unavailable");
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy full source document" }));
  expect(screen.getByText("Could not copy the document. Try copying again.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy full source document" }));
  expect(mocks.copy).toHaveBeenLastCalledWith(before);
  expect(screen.getByText("Full document copied")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy full target document" }));
  expect(mocks.copy).toHaveBeenLastCalledWith("target");
});

it("bounds an explicitly expanded full document instead of rendering every Monaco line", () => {
  const source = Array.from({ length: 1500 }, (_, index) => `key${index}: value`).join("\n");
  render(<HelmRevisionDiff before={source} after={source} beforeLabel="Source" afterLabel="Target" />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(screen.getByText("Document display exceeds the safe rendering limit.")).toBeTruthy();
  expect((screen.getByLabelText("Source") as HTMLTextAreaElement).value.split("\n")).toHaveLength(1000);
  expect((screen.getByLabelText("Show full documents") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("reveals an original match beyond the bounded full-document preview", () => {
  const source = Array.from({ length: 1500 }, (_, index) => `key${index}: value`).join("\n");
  render(<HelmRevisionDiff before={source} after={source} beforeLabel="Source" afterLabel="Target" />);
  fireEvent.click(screen.getByLabelText("Show full documents"));
  fireEvent.keyDown(screen.getByLabelText("Source"), { key: "f", ctrlKey: true });
  fireEvent.change(screen.getByLabelText("Find in both documents"), { target: { value: "key1400:" } });
  expect(screen.getByText("2 matches · Source line 1401, column 1")).toBeTruthy();
  const excerpt = screen.getByLabelText("Matching original document excerpt") as HTMLTextAreaElement;
  expect(excerpt.value).toContain("key1400: value");
  expect(excerpt.value.split("\n")).toHaveLength(7);
  const props = [...mocks.props]
    .reverse()
    .find((props) => props.options.ariaLabel === "Matching original document excerpt");
  expect(props.options.lineNumbers(4)).toBe("1401");
  fireEvent.click(screen.getByText("Next match"));
  expect(screen.getByText("2 matches · Target line 1401, column 1")).toBeTruthy();
  expect((screen.getByLabelText("Matching original document excerpt") as HTMLTextAreaElement).value).toContain(
    "key1400: value",
  );
});

it("routes vertical wheel over Monaco to the owned shared viewport and disposes the bridge", () => {
  const viewport = document.createElement("div");
  const editor = document.createElement("textarea");
  viewport.append(editor);
  Object.defineProperties(viewport, { clientHeight: { value: 300 }, scrollHeight: { value: 900 } });
  const native = vi.fn();
  editor.addEventListener("wheel", native);
  const dispose = bindHelmDiffWheel(viewport);
  const wheel = (deltaY: number, deltaMode = 0, extra: WheelEventInit = {}) => {
    const event = new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true, ...extra });
    editor.dispatchEvent(event);
    return event;
  };
  expect(wheel(120).defaultPrevented).toBe(true);
  expect(viewport.scrollTop).toBe(120);
  expect(native).not.toHaveBeenCalled();
  wheel(2, 1);
  expect(viewport.scrollTop).toBe(156);
  wheel(1, 2);
  expect(viewport.scrollTop).toBe(456);
  wheel(900);
  expect(viewport.scrollTop).toBe(600);
  expect(wheel(20).defaultPrevented).toBe(false);
  wheel(-900);
  expect(viewport.scrollTop).toBe(0);
  expect(wheel(-20).defaultPrevented).toBe(false);
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 100 }]) {
    expect(wheel(50, 0, modifiers).defaultPrevented).toBe(false);
    expect(viewport.scrollTop).toBe(0);
  }
  dispose();
  expect(wheel(100).defaultPrevented).toBe(false);
  expect(viewport.scrollTop).toBe(0);
});

it("synchronizes owned horizontal scroll in either direction across blocks without feedback and cleans up", () => {
  const controller = createHelmHorizontalScroll();
  const left = document.createElement("div"),
    right = document.createElement("div"),
    otherBlock = document.createElement("div");
  const dispose = [left, right, otherBlock].map((viewport) => controller.register(viewport));
  left.scrollLeft = 120;
  fireEvent.scroll(left);
  expect([right.scrollLeft, otherBlock.scrollLeft]).toEqual([120, 120]);
  fireEvent.scroll(right);
  fireEvent.scroll(otherBlock);
  expect(left.scrollLeft).toBe(120);
  right.scrollLeft = 45;
  fireEvent.scroll(right);
  expect([left.scrollLeft, otherBlock.scrollLeft]).toEqual([45, 45]);
  const newlyMounted = document.createElement("div");
  const removeNew = controller.register(newlyMounted);
  expect(newlyMounted.scrollLeft).toBe(45);
  dispose.forEach((cleanup) => cleanup());
  removeNew();
  left.scrollLeft = 300;
  fireEvent.scroll(left);
  expect(right.scrollLeft).toBe(45);
});

it("shares native public content measurements in compact, full and fallback editors", () => {
  const source = Array.from({ length: 30 }, (_, index) => `key${index}: original`);
  const target = [...source];
  target[10] = "replacement";
  const view = render(
    <HelmRevisionDiff before={source.join("\n")} after={target.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  act(() => {
    const props = mocks.props[mocks.props.length - 1];
    props.onDidLayoutChange({ width: 400, contentWidth: 320 });
    props.onDidContentSizeChange({ contentWidth: 1200 });
  });
  const latest = mocks.props.slice(-screen.getAllByRole("textbox").length);
  expect(latest.every((props) => props.style.width === 1280)).toBe(true);
  const roots = Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view"));
  roots[0].scrollLeft = 200;
  fireEvent.scroll(roots[0]);
  expect(roots.every((root) => root.scrollLeft === 200)).toBe(true);
  fireEvent.click(screen.getByLabelText("Show full documents"));
  const fullRoots = Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view"));
  expect(fullRoots.every((root) => root.scrollLeft === 200)).toBe(true);
  view.rerender(
    <HelmRevisionDiff before={"x".repeat(1024 * 1024 + 1)} after="target" beforeLabel="Source" afterLabel="Target" />,
  );
  const fallback = Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view"));
  fallback[1].scrollLeft = 70;
  fireEvent.scroll(fallback[1]);
  expect(fallback[0].scrollLeft).toBe(70);
  expect(mocks.props.slice(-2).every((props) => props.options.scrollbar.horizontal === "hidden")).toBe(true);
});

it("routes horizontal and shift wheel through owned panes while preserving vertical and zoom gestures", () => {
  const controller = createHelmHorizontalScroll();
  const left = document.createElement("div"),
    right = document.createElement("div");
  Object.defineProperties(left, { clientWidth: { value: 200 }, scrollWidth: { value: 1000 } });
  const remove = controller.register(left),
    removeRight = controller.register(right);
  const wheel = (data: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...data });
    left.dispatchEvent(event);
    return event;
  };
  expect(wheel({ deltaX: 80 }).defaultPrevented).toBe(true);
  expect(right.scrollLeft).toBe(80);
  wheel({ deltaY: 2, deltaMode: 1, shiftKey: true });
  expect(right.scrollLeft).toBe(116);
  wheel({ deltaX: 1, deltaMode: 2 });
  expect(right.scrollLeft).toBe(316);
  for (const data of [{ deltaY: 100 }, { deltaX: 100, ctrlKey: true }, { deltaX: 100, metaKey: true }])
    expect(wheel(data).defaultPrevented).toBe(false);
  expect(right.scrollLeft).toBe(316);
  remove();
  removeRight();
});

it("obtains initial measurements when native subscriptions miss creation events", () => {
  mocks.lateMeasurements = true;
  const before = "x".repeat(100),
    after = "y".repeat(100);
  render(<HelmRevisionDiff before={before} after={after} beforeLabel="Source" afterLabel="Target" />);
  expect(mocks.props.some((props) => props.value === "" && props.style.width === "calc(100% - 1px)")).toBe(true);
  expect(mocks.props.slice(-2).every((props) => props.style.width === 880)).toBe(true);
  expect((screen.getByLabelText("Source") as HTMLTextAreaElement).value).toBe(before);
  expect((screen.getByLabelText("Target") as HTMLTextAreaElement).value).toBe(after);
});

it("measures newly mounted full-context editors when a shared width is already known", () => {
  mocks.lateMeasurements = true;
  const before = Array.from({ length: 30 }, (_, index) => `key${index}: same`);
  before[0] = "hidden: " + "x".repeat(200);
  const after = [...before];
  after[10] = "key10: changed";
  render(
    <HelmRevisionDiff before={before.join("\n")} after={after.join("\n")} beforeLabel="Source" afterLabel="Target" />,
  );
  const compactWidth = mocks.props[mocks.props.length - 1].style.width;
  expect(typeof compactWidth).toBe("number");
  mocks.props.length = 0;
  fireEvent.click(screen.getByLabelText("Show full documents"));
  expect(mocks.props.some((props) => props.value === "" && props.style.width === compactWidth - 1)).toBe(true);
  const fullWidth = mocks.props[mocks.props.length - 1].style.width;
  expect(fullWidth).toBeGreaterThan(compactWidth);
  expect(
    mocks.props.slice(-screen.getAllByRole("textbox").length).every((props) => props.style.width === fullWidth),
  ).toBe(true);
});

it("shares either pinned footer bar with both panes and cleans up detached footer listeners", () => {
  const view = render(<HelmRevisionDiff before="source" after="target" beforeLabel="Source" afterLabel="Target" />);
  const sourceBar = screen.getByLabelText("Source horizontal scroll"),
    targetBar = screen.getByLabelText("Target horizontal scroll");
  expect(view.container.querySelectorAll(".helm-diff-horizontal-scroll")).toHaveLength(2);
  expect(
    view.container
      .querySelector(".helm-diff-horizontal-footer")
      ?.previousElementSibling?.classList.contains("helm-diff-scroll"),
  ).toBe(true);
  sourceBar.scrollLeft = 90;
  fireEvent.scroll(sourceBar);
  const roots = Array.from(view.container.querySelectorAll<HTMLElement>(".helm-code-view"));
  expect([targetBar.scrollLeft, ...roots.map((root) => root.scrollLeft)]).toEqual([90, 90, 90]);
  targetBar.scrollLeft = 40;
  fireEvent.scroll(targetBar);
  expect([sourceBar.scrollLeft, ...roots.map((root) => root.scrollLeft)]).toEqual([40, 40, 40]);
  expect(roots.every((root) => root.classList.contains("helm-code-view-horizontal"))).toBe(true);
  view.unmount();
  sourceBar.scrollLeft = 150;
  fireEvent.scroll(sourceBar);
  expect(targetBar.scrollLeft).toBe(40);
});

it("exposes keyboard footer scrolling only when its content overflows", () => {
  render(<HelmRevisionDiff before="source" after="target" beforeLabel="Source" afterLabel="Target" />);
  const sourceBar = screen.getByLabelText("Source horizontal scroll");
  expect(sourceBar.tabIndex).toBe(-1);
  expect(sourceBar.style.height).toBe("0px");
  let width = 1000;
  Object.defineProperties(sourceBar, { clientWidth: { value: 200 }, scrollWidth: { get: () => width } });
  fireEvent.resize(window);
  expect(sourceBar.tabIndex).toBe(0);
  expect(sourceBar.getAttribute("aria-hidden")).toBe("false");
  expect(sourceBar.style.height).toBe("16px");
  width = 200;
  fireEvent.resize(window);
  expect(sourceBar.tabIndex).toBe(-1);
  expect(sourceBar.getAttribute("aria-hidden")).toBe("true");
  expect(sourceBar.style.height).toBe("0px");
});

it("keeps both captions in the same stretching sticky header row when one caption wraps", () => {
  const view = render(
    <HelmRevisionDiff
      before="source"
      after="target"
      beforeLabel={<span>Revision 1</span>}
      afterLabel={
        <>
          <span>Latest revision 2</span>
          <span>Failed</span>
          <span>App version 1.0</span>
        </>
      }
    />,
  );
  const source = screen.getByRole("heading", { name: "Revision 1" });
  const target = screen.getByRole("heading", { name: /Latest revision 2/ });
  expect(source.parentElement).toBe(target.parentElement);
  expect(source.parentElement?.classList.contains("helm-diff-headers")).toBe(true);
  expect(Array.from(source.parentElement!.children)).toEqual([source, target]);
  expect(source.parentElement?.nextElementSibling?.querySelectorAll(".helm-code-view")).toHaveLength(2);
  expect(view.container.querySelectorAll(".helm-diff-headers")).toHaveLength(1);
});

it("reveals a find match below the measured wrapped sticky header", () => {
  const view = render(<HelmRevisionDiff before="old" after="find this" beforeLabel="Source" afterLabel="Target" />);
  const viewport = screen.getByLabelText("Comparison documents");
  const header = view.container.querySelector<HTMLElement>(".helm-diff-headers")!;
  const block = view.container.querySelector<HTMLElement>("[data-helm-after-start]")!;
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue({ height: 74 } as DOMRect);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue({ top: 500 } as DOMRect);
  fireEvent.keyDown(screen.getByLabelText("Source"), { key: "f", ctrlKey: true });
  fireEvent.change(screen.getByLabelText("Find in both documents"), { target: { value: "find this" } });
  expect(viewport.scrollTop).toBe(318);
  expect(500 - viewport.scrollTop).toBeGreaterThan(100 + 74);
});
