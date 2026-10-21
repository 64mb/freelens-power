import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {}, ipcMain: {} }));

import { parseAiModels, readAiModels } from "./ai-models";

const model = {
  slug: "example-model",
  display_name: "Example model",
  visibility: "list",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
};

describe("local AI model catalog", () => {
  it("returns only bounded model metadata and supported effort values", () => {
    expect(
      parseAiModels({
        models: [
          {
            ...model,
            endpoint: "sensitive",
            identity: "private",
            supported_reasoning_levels: [
              ...model.supported_reasoning_levels,
              { effort: "--unsafe" },
              { effort: "high" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "example-model",
        label: "Example model",
        defaultReasoningEffort: "medium",
        reasoningEfforts: ["low", "medium", "high"],
      },
    ]);
  });
  it("ignores hidden, malformed and duplicate models and invalid defaults", () => {
    expect(
      parseAiModels({
        models: [
          null,
          { ...model, visibility: "hide" },
          { ...model, slug: "--invalid" },
          { ...model, display_name: "https://example.invalid", default_reasoning_level: "invalid" },
          model,
        ],
      }),
    ).toEqual([
      {
        id: "example-model",
        label: "example-model",
        defaultReasoningEffort: "",
        reasoningEfforts: ["low", "medium", "high"],
      },
    ]);
    expect(parseAiModels({ models: {} })).toEqual([]);
  });
  it("falls back safely for missing, invalid and oversized cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-models-"));
    try {
      expect(await readAiModels(directory)).toEqual([]);
      await writeFile(join(directory, "models_cache.json"), "invalid");
      expect(await readAiModels(directory)).toEqual([]);
      await writeFile(join(directory, "models_cache.json"), " ".repeat(2 * 1024 * 1024 + 1));
      expect(await readAiModels(directory)).toEqual([]);
      await writeFile(join(directory, "models_cache.json"), JSON.stringify({ models: [model] }));
      expect(await readAiModels(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
