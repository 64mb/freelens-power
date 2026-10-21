// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiCopyAnswer } from "./ai-copy-answer";
import { AiMessageContent, terminalInsertText } from "./ai-message";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  writeText: vi.fn(),
  isConnected: vi.fn((_id: string) => false),
  getTerminalApi: vi.fn((_id: string): { isReady: boolean; isConnected: () => boolean } => ({
    isReady: true,
    isConnected: () => true,
  })),
  createTerminalTab: vi.fn(() => ({ id: "terminal-tab" })),
  sendCommand: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({ clipboard: { writeText: mocks.writeText }, shell: { openExternal: mocks.openExternal } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      createTerminalTab: mocks.createTerminalTab,
      terminalStore: {
        sendCommand: mocks.sendCommand,
        isConnected: mocks.isConnected,
        getTerminalApi: mocks.getTerminalApi,
      },
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isConnected.mockReturnValue(false);
  mocks.getTerminalApi.mockImplementation(() => ({ isReady: true, isConnected: () => true }));
});
describe("AI message content", () => {
  it("renders formatting as safe React text and copies exact fenced contents only on click", () => {
    const command = 'printf "<example> & text"\n';
    const { container } = render(
      <AiMessageContent text={'**Inspect** `pods`\n\n<img src=x onerror="alert(1)">\n\n```sh\n' + command + "```"} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Inspect");
    expect(container.querySelector("img")).toBeNull();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.createTerminalTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Copy code"));
    expect(mocks.writeText).toHaveBeenCalledWith(command);
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });
  it("keeps copying available but hides insertion without an active terminal", () => {
    render(<AiMessageContent text={"```bash\nprintf example\n```"} />);
    expect(screen.queryByLabelText("Insert into terminal")).toBeNull();
    fireEvent.click(screen.getByLabelText("Copy code"));
    expect(mocks.writeText).toHaveBeenCalledWith("printf example\n");
    expect(mocks.createTerminalTab).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
  it("rejects embedded line endings and terminal control characters", () => {
    for (const text of [
      "echo one\necho two\n",
      "echo one\recho two",
      "echo\tvalue",
      "echo\u001b[A",
      "echo\u0085value",
      "echo\u2028value",
    ])
      expect(terminalInsertText(text)).toBeUndefined();
    mocks.isConnected.mockReturnValue(true);
    render(
      <>
        <div data-testid="dock-tab-content-for-active-terminal" />
        <AiMessageContent text={"```sh\necho one\necho two\n```"} />
      </>,
    );
    fireEvent.click(screen.getByLabelText("Insert into terminal"));
    expect(mocks.createTerminalTab).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });
  it("offers copy but no terminal action for configuration blocks", () => {
    render(<AiMessageContent text={"```yaml\nkind: Pod\n```"} />);
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
    expect(screen.queryByLabelText("Insert into terminal")).toBeNull();
  });
});

it("renders headings, nested lists, tables, quotes, emphasis and safe links", () => {
  const { container } = render(
    <AiMessageContent
      text={[
        "## Findings",
        "",
        "1. Parent",
        "   - **Nested** item",
        "   - Second item",
        "",
        "> Quoted `log`",
        "",
        "| Resource | Status |",
        "| --- | --- |",
        "| pod | *Ready* |",
        "",
        "[Reference](https://example.com/docs) and https://example.org",
        "",
        "~~Resolved~~",
      ].join("\n")}
    />,
  );
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Findings");
  expect(container.querySelector("ol > li > ul > li strong")?.textContent).toBe("Nested");
  expect(container.querySelector("blockquote code")?.textContent).toBe("log");
  expect(screen.getByRole("table").querySelector("td")?.textContent).toBe("pod");
  expect(container.querySelector("s")?.textContent).toBe("Resolved");
  const link = screen.getByRole("link", { name: "Reference" });
  fireEvent.click(link);
  expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/docs");
});

it("keeps HTML and unsafe links inert without loading remote images or changing the host route", () => {
  const { container } = render(
    <AiMessageContent
      text={[
        '<script>alert(1)</script><img src=x onerror="alert(1)">',
        "",
        "[Bad](javascript:alert(1)) [File](file:///tmp/example) [Data](data:text/html;base64,PGgxPkJhZDwvaDE+)",
        "",
        "[Encoded](jav&#x61;script:alert(1)) [Relative](/preferences)",
        "",
        "![Diagram](https://example.com/image.png)",
        "",
        "[Good](https://example.com/)",
      ].join("\n")}
    />,
  );
  expect(container.querySelector("script, img")).toBeNull();
  expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
  expect(screen.queryByRole("link", { name: "File" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Data" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Encoded" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Relative" })).toBeNull();
  expect(mocks.openExternal).not.toHaveBeenCalled();
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  screen.getByRole("link", { name: "Good" }).dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const middleClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  screen.getByRole("link", { name: "Good" }).dispatchEvent(middleClick);
  expect(middleClick.defaultPrevented).toBe(true);
  expect(mocks.openExternal).toHaveBeenLastCalledWith("https://example.com/");
});

it("supports tilde and indented code fences while retaining single-line insertion guards", () => {
  mocks.isConnected.mockReturnValue(true);
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"~~~sh\nprintf example\n~~~\n\n    kind: Pod\n"} />
    </>,
  );
  expect(screen.getAllByLabelText("Copy code")).toHaveLength(2);
  expect(screen.getAllByLabelText("Insert into terminal")).toHaveLength(2);
  fireEvent.click(screen.getAllByLabelText("Copy code")[0]);
  expect(mocks.writeText).toHaveBeenCalledWith("printf example\n");
});

it("reuses the visible connected terminal without creating a new tab", async () => {
  mocks.isConnected.mockImplementation((id: string) => id === "active-terminal");
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  fireEvent.click(screen.getByLabelText("Insert into terminal"));
  await waitFor(() =>
    expect(mocks.sendCommand).toHaveBeenCalledWith("printf example", { enter: false, tabId: "active-terminal" }),
  );
  expect(mocks.createTerminalTab).not.toHaveBeenCalled();
});

it("ignores hidden connected terminals and active non-terminal tabs", async () => {
  mocks.isConnected.mockImplementation((id: string) => id === "hidden-terminal");
  render(
    <>
      <div style={{ display: "none" }}>
        <div data-testid="dock-tab-content-for-hidden-terminal" />
      </div>
      <div data-testid="dock-tab-content-for-active-logs" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  expect(screen.queryByLabelText("Insert into terminal")).toBeNull();
  expect(mocks.isConnected).not.toHaveBeenCalledWith("hidden-terminal");
  expect(mocks.createTerminalTab).not.toHaveBeenCalled();
  expect(mocks.sendCommand).not.toHaveBeenCalled();
});

it("does not send multiline or control sequences to an already open terminal", () => {
  mocks.isConnected.mockReturnValue(true);
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\necho one\necho two\n```\n\n```bash\necho \u001b[A\n```"} />
    </>,
  );
  for (const button of screen.getAllByLabelText("Insert into terminal")) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(mocks.sendCommand).not.toHaveBeenCalled();
  expect(mocks.createTerminalTab).not.toHaveBeenCalled();
});

it("updates insertion availability when the active dock tab changes and rechecks it at click time", async () => {
  mocks.isConnected.mockImplementation((id: string) => id === "first" || id === "second");
  const { rerender } = render(
    <>
      <div data-testid="dock-tab-content-for-first" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  const insert = screen.getByLabelText("Insert into terminal") as HTMLButtonElement;
  await waitFor(() => expect(insert.disabled).toBe(false));
  rerender(
    <>
      <div data-testid="dock-tab-content-for-second" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  fireEvent.click(insert);
  await waitFor(() =>
    expect(mocks.sendCommand).toHaveBeenCalledWith("printf example", { enter: false, tabId: "second" }),
  );
  rerender(
    <>
      <div data-testid="dock-tab-content-for-logs" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  await waitFor(() => expect(screen.queryByLabelText("Insert into terminal")).toBeNull());
  expect(mocks.createTerminalTab).not.toHaveBeenCalled();
});

it("trims only surrounding CR and LF from terminal insertion while preserving copied code", async () => {
  expect(terminalInsertText("\r\n\nprintf example\r\n\r\n")).toBe("printf example");
  expect(terminalInsertText("\n  printf example  \r\n")).toBe("  printf example  ");
  expect(terminalInsertText("\n\r")).toBeUndefined();
  expect(terminalInsertText("printf one\r\nprintf two")).toBeUndefined();
  mocks.isConnected.mockReturnValue(true);
  const code = "\nprintf example\n\n";
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\n" + code + "```"} />
    </>,
  );
  fireEvent.click(screen.getByLabelText("Copy code"));
  expect(mocks.writeText).toHaveBeenCalledWith(code);
  fireEvent.click(screen.getByLabelText("Insert into terminal"));
  await waitFor(() =>
    expect(mocks.sendCommand).toHaveBeenCalledWith("printf example", { enter: false, tabId: "active-terminal" }),
  );
});

it("hides insertion when the active terminal entry exists but its API is unready or disconnected", () => {
  mocks.isConnected.mockReturnValue(true);
  mocks.getTerminalApi.mockReturnValue({ isReady: false, isConnected: () => true });
  const view = render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  expect(screen.queryByLabelText("Insert into terminal")).toBeNull();
  view.unmount();
  mocks.getTerminalApi.mockReturnValue({ isReady: true, isConnected: () => false });
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  expect(screen.queryByLabelText("Insert into terminal")).toBeNull();
  expect(screen.getByLabelText("Copy code")).toBeTruthy();
  expect(mocks.sendCommand).not.toHaveBeenCalled();
});

it("rechecks API readiness on click without queuing a deferred command", () => {
  mocks.isConnected.mockReturnValue(true);
  render(
    <>
      <div data-testid="dock-tab-content-for-active-terminal" />
      <AiMessageContent text={"```sh\nprintf example\n```"} />
    </>,
  );
  const insert = screen.getByLabelText("Insert into terminal");
  mocks.getTerminalApi.mockReturnValue({ isReady: false, isConnected: () => false });
  fireEvent.click(insert);
  expect(mocks.sendCommand).not.toHaveBeenCalled();
  expect(mocks.createTerminalTab).not.toHaveBeenCalled();
});

it("copies the full assistant answer with original Markdown only after an explicit click", () => {
  const text = "## Result\n\n- **Ready**\n\n```sh\necho example\n```";
  render(<AiCopyAnswer text={text} />);
  expect(mocks.writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText("Copy answer"));
  expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(text);
  expect(screen.getByLabelText("Copy answer").getAttribute("title")).toBe("Copied");
});
