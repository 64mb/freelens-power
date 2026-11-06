// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";
import { AiPreferences } from "./preferences/ai-preferences";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), preferences: {} as Record<string, unknown> }));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("../common/store/ai-preferences-store", () => ({
  AiPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./preferences/ai-shortcuts-preferences", () => ({ AiShortcutsPreferences: () => null }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Input: ({ onChange, ...props }: any) => <input {...props} onChange={(event) => onChange(event.target.value)} />,
      Button: (props: any) => <button {...props} />,
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
      Switch: ({ children, checked, disabled, onChange }: any) => (
        <label>
          <input
            type="checkbox"
            checked={!!checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          {children}
        </label>
      ),
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
    piModel: "example/glm-5-3",
    piReasoningEffort: "high",
    claudeModel: "",
    claudeReasoningEffort: "",
    claudeSpeed: "default",
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
      : provider === "pi"
        ? Promise.resolve([
            { id: "example/deepseek-v4-flash", label: "DeepSeek", reasoningEfforts: ["off", "high"] },
            { id: "example/glm-5-3", label: "GLM", reasoningEfforts: ["off", "high"] },
          ])
        : Promise.resolve([
            { id: "sonnet", label: "Sonnet", reasoningEfforts: ["low", "max"] },
            { id: "haiku", label: "Haiku", reasoningEfforts: ["low"] },
          ]),
  );
  const view = render(<AiPreferences />);
  try {
    expect(screen.getByText("Local Codex model catalog.").title).toBe("Local Codex model catalog.");
    expect(screen.getByText("Fast mode depends on model and account.").title).toBe(
      "Fast mode depends on model and account.",
    );
    expect(screen.getByText("Controls reasoning depth; higher may take longer.")).toBeTruthy();
    const savedEffort = screen.getByLabelText("Effort") as HTMLSelectElement;
    expect(savedEffort.selectedOptions[0].text).toBe("High");
    expect(savedEffort.value).toBe("high");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example-model" } });
    expect(mocks.preferences.reasoningEffort).toBe("high");
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude" } });
    await waitFor(() => expect(screen.getByText("Sonnet")).toBeTruthy());
    expect(screen.getByText("Claude model aliases.").title).toBe("Claude model aliases.");
    expect(screen.getByText("Fast mode for Opus; account access required.").title).toBe(
      "Fast mode for Opus; account access required.",
    );
    expect(screen.queryByText("Fast mode depends on model and account.")).toBeNull();
    expect((screen.getByLabelText("Speed") as HTMLSelectElement).value).toBe("default");
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "fast" } });
    expect(mocks.preferences.claudeSpeed).toBe("fast");
    await act(async () => finishCodex([{ id: "stale-model", label: "Stale", reasoningEfforts: ["xhigh"] }]));
    expect(screen.queryByText("Stale")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
    const effortOptions = Array.from((screen.getByLabelText("Effort") as HTMLSelectElement).options);
    expect(effortOptions.map(({ value, text }) => ({ value, text }))).toEqual([
      { value: "", text: "Default" },
      { value: "low", text: "Low" },
      { value: "max", text: "Max" },
    ]);
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "max" } });
    expect(mocks.preferences.claudeModel).toBe("sonnet");
    expect(mocks.preferences.claudeReasoningEffort).toBe("max");
    expect(mocks.preferences.model).toBe("example-model");
    expect(mocks.preferences.reasoningEffort).toBe("high");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "haiku" } });
    expect(mocks.preferences.claudeReasoningEffort).toBe("");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).options).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "pi" } });
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeTruthy());
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("example/glm-5-3");
    expect(screen.queryByLabelText("Speed")).toBeNull();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example/deepseek-v4-flash" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "off" } });
    expect(mocks.preferences.piModel).toBe("example/deepseek-v4-flash");
    expect(mocks.preferences.piReasoningEffort).toBe("off");
    expect(mocks.preferences.speed).toBe("fast");
    expect(mocks.preferences.claudeSpeed).toBe("fast");
    act(() =>
      runInAction(() => {
        mocks.preferences.enabled = false;
      }),
    );
    expect((screen.getByLabelText("Provider") as HTMLSelectElement).disabled).toBe(true);
  } finally {
    view.unmount();
  }
});

it("selects the first configured Pi model instead of offering an unsupported default", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "pi",
    piModel: "",
    piReasoningEffort: "max",
    model: "codex-model",
    reasoningEffort: "high",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  mocks.invoke.mockResolvedValue([
    { id: "example/deepseek-v4-flash", label: "DeepSeek", reasoningEfforts: ["off", "high"] },
  ]);
  const view = render(<AiPreferences />);
  try {
    await waitFor(() => expect(mocks.preferences.piModel).toBe("example/deepseek-v4-flash"));
    expect(mocks.preferences.piReasoningEffort).toBe("");
    expect(mocks.preferences.model).toBe("codex-model");
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(Array.from(model.options).map((option) => option.value)).toEqual(["example/deepseek-v4-flash"]);
    expect(screen.queryByText("Pi default")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("keeps Pi unconfigured with a selection hint when its catalog is empty", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "pi",
    piModel: "",
    piReasoningEffort: "",
    model: "codex-model",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  mocks.invoke.mockResolvedValue([]);
  const view = render(<AiPreferences />);
  try {
    await act(async () => {});
    expect(mocks.preferences.piModel).toBe("");
    expect(screen.getByText("Configure a Pi model in the CLI, then select it here.")).toBeTruthy();
    expect(screen.getByText("Select a configured Pi model")).toBeTruthy();
    expect(screen.queryByText("Pi default")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("shows friendly Pi models and only each model's supported effort choices", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "pi",
    piModel: "example/glm-5-3",
    piReasoningEffort: "medium",
    model: "codex-model",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  mocks.invoke.mockResolvedValue([
    {
      id: "example/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
    },
    { id: "example/glm-5-3", label: "GLM 5.3", reasoningEfforts: ["low", "high", "max"] },
  ]);
  const view = render(<AiPreferences />);
  const labels = (id: string) =>
    Array.from((screen.getByLabelText(id) as HTMLSelectElement).options).map((option) => option.text);
  try {
    await waitFor(() => expect(mocks.preferences.piReasoningEffort).toBe(""));
    expect(labels("Model")).toEqual(["DeepSeek V4 Flash", "GLM 5.3"]);
    expect(labels("Effort")).toEqual(["Default", "Low", "High", "Max"]);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example/deepseek-v4-flash" } });
    expect(labels("Effort")).toEqual(["Default", "None", "Minimal", "Low", "Medium", "High", "XHigh"]);
    expect(mocks.preferences.model).toBe("codex-model");
  } finally {
    view.unmount();
  }
});

it("keeps API credentials in the password field and secure IPC only", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "codex-api",
    codexApiModel: "api-model",
    codexApiReasoningEffort: "high",
    codexApiServiceTier: "default",
    model: "cli-model",
    reasoningEffort: "low",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  let configured = false;
  mocks.invoke.mockImplementation(async (channel, value) => {
    if (channel === "freelens-power:ai-api-key-status") return { available: true, configured };
    if (channel === "freelens-power:ai-api-key-set") {
      configured = Boolean(value);
      return { available: true, configured };
    }
    return [{ id: "api-model", label: "API model", reasoningEfforts: ["low", "high"] }];
  });
  const view = render(<AiPreferences />);
  try {
    await waitFor(() => expect(screen.getByText("No API key configured.")).toBeTruthy());
    expect([...screen.getByLabelText("Effort").querySelectorAll("option")].some((option) => option.value === "")).toBe(
      false,
    );
    expect([...screen.getByLabelText("Provider").querySelectorAll("option")].map((el) => el.textContent)).toEqual([
      "Codex",
      "Claude",
      "Pi",
      "OpenAI API",
    ]);
    expect([...screen.getByLabelText("Speed").querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Default",
      "Fast",
      "Ultrafast",
    ]);
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "ultrafast" } });
    expect(mocks.preferences.codexApiServiceTier).toBe("ultrafast");
    expect(mocks.preferences.speed).toBeUndefined();
    expect(screen.queryByLabelText("WebSocket mode")).toBeNull();
    const field = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(screen.getByText("Requires a restricted API key with write access to Responses API.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "example-test-credential" } });
    fireEvent.click(screen.getByText("Save"));
    expect(field.value).toBe("");
    await waitFor(() => expect(screen.getByText("API key configured in secure storage.")).toBeTruthy());
    expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:ai-api-key-set", "example-test-credential");
    expect(JSON.stringify(mocks.preferences)).not.toContain("example-test-credential");
    expect(view.container.textContent).not.toContain("example-test-credential");
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "low" } });
    expect(mocks.preferences.codexApiReasoningEffort).toBe("low");
    expect(mocks.preferences.reasoningEffort).toBe("low");
    fireEvent.click(screen.getByText("Clear"));
    await waitFor(() => expect(screen.getByText("No API key configured.")).toBeTruthy());
    expect(mocks.invoke).toHaveBeenCalledWith("freelens-power:ai-api-key-set", "");
    fireEvent.change(field, { target: { value: "unsaved-test-credential" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex-api" } });
    await waitFor(() => expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).value).toBe(""));
  } finally {
    view.unmount();
  }
});

it("disables API key updates when secure storage is unavailable", async () => {
  mocks.preferences = observable({
    enabled: true,
    provider: "codex-api",
    codexApiModel: "",
    codexApiReasoningEffort: "high",
    chatFontSize: 14,
    systemPrompt: "",
    clusterPrompt: "",
  });
  mocks.invoke.mockImplementation(async (channel) =>
    channel === "freelens-power:ai-api-key-status" ? { available: false, configured: false } : [],
  );
  const view = render(<AiPreferences />);
  try {
    await waitFor(() =>
      expect(screen.getByText("Secure key storage is unavailable. OpenAI API cannot be used.")).toBeTruthy(),
    );
    expect((screen.getByLabelText("OpenAI API key") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Clear") as HTMLButtonElement).disabled).toBe(true);
  } finally {
    view.unmount();
  }
});
