// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HelmCodeView, HelmRevisionDiff, openHelmDocumentFind } from "./helm-code-view";

const mocks = vi.hoisted(() => ({ models: [] as any[], props: [] as any[] }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
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
  expect((screen.getByLabelText("Selected") as HTMLTextAreaElement).value).toBe(before);
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
