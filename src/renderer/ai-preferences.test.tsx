// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";
import { AiPreferences } from "./preferences/ai-preferences";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), preferences: {} as Record<string, unknown> }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("../common/store/ai-preferences-store", () => ({
  AiPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./preferences/ai-shortcuts-preferences", () => ({ AiShortcutsPreferences: () => null }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Select: ({
        id,
        value,
        options,
        isDisabled,
        onChange,
      }: {
        id: string;
        value: string;
        options: { value: string; label: string }[];
        isDisabled: boolean;
        onChange?: (option: { value: string; label: string }) => void;
      }) => (
        <select
          id={id}
          value={value}
          disabled={isDisabled}
          onChange={(event) => {
            const option = options.find((option) => String(option.value) === event.target.value);
            if (option) onChange?.(option);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ),
      Switch: () => null,
    },
  },
}));
afterEach(() => vi.clearAllMocks());

it("keeps provider controls separate and ignores late model catalogs after switching", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "codex",
    model: "example-model",
    reasoningEffort: "high",
    speed: "fast",
    claudeModel: "",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  let finishCodex: (value: unknown) => void = () => {};
  mocks.invoke.mockImplementation((_channel, provider) =>
    provider === "codex"
      ? new Promise((resolve) => {
          finishCodex = resolve;
        })
      : Promise.resolve([{ id: "sonnet", label: "Sonnet", reasoningEfforts: [] }]),
  );
  const view = render(<AiPreferences />);
  try {
    expect(screen.getByLabelText("Speed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CLI"), { target: { value: "claude" } });
    await waitFor(() => expect(screen.getByText("Sonnet · Default")).toBeTruthy());
    expect(screen.getByLabelText("Speed")).toBeTruthy();
    await act(async () => finishCodex([{ id: "stale-model", label: "Stale", reasoningEfforts: ["xhigh"] }]));
    expect(screen.queryByText("Stale · xhigh")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: JSON.stringify(["sonnet", ""]) } });
    expect(mocks.preferences.claudeModel).toBe("sonnet");
    expect(mocks.preferences.model).toBe("example-model");
    expect(mocks.preferences.reasoningEffort).toBe("high");
    act(() =>
      runInAction(() => {
        mocks.preferences.enabled = false;
      }),
    );
    expect((screen.getByLabelText("CLI") as HTMLSelectElement).disabled).toBe(true);
  } finally {
    view.unmount();
  }
});
