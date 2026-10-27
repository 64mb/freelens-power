// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HelmCodeView, HelmRevisionDiff } from "./helm-code-view";

const mocks = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      MonacoEditor: (props: any) => {
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
