import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));

import { parsePiAiModels, readPiAiModels } from "./ai-pi-models";

const table = `provider model context max-out thinking images
example deepseek-v4-flash 1M 32K yes no
example glm-5-3 200K 64K no yes`;

describe("Pi local model catalog", () => {
  it("parses qualified model IDs and reasoning support from CLI table rows", () => {
    expect(parsePiAiModels(table)).toEqual([
      {
        id: "example/deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "",
      },
      { id: "example/glm-5-3", label: "GLM 5.3", reasoningEfforts: [], defaultReasoningEffort: "" },
    ]);
  });

  it("ignores duplicate rows, diagnostics and malformed identifiers", () => {
    expect(
      parsePiAiModels(
        `${table}\n${table}\nother deepseek-v4-flash 1M 32K yes no\nother namespace/glm-5-3 1M 32K yes no\n--bad model 1M 1K yes yes\nexample --bad 1M 1K yes yes\nexample other-model 1M 1K yes yes\nWarning: unavailable credentials`,
      ),
    ).toHaveLength(2);
    expect(parsePiAiModels("x".repeat(2 * 1024 * 1024 + 1))).toEqual([]);
    expect(parsePiAiModels("No models available")).toEqual([]);
  });

  it("isolates configuration, bounds CLI execution and removes temporary credentials", async () => {
    const original = await mkdtemp(join(tmpdir(), "pi-catalog-test-"));
    let cwd = "";
    try {
      await writeFile(join(original, "auth.json"), JSON.stringify({ example: { type: "api_key", key: "test" } }));
      execute.mockImplementation((_file, _args, options, callback) => {
        cwd = options.cwd;
        expect(options).toMatchObject({ shell: false, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
        expect(options.env.PI_CODING_AGENT_DIR).toBe(join(cwd, "pi-agent"));
        expect(options.env.NODE_OPTIONS).toBeUndefined();
        expect(_args).toEqual(
          expect.arrayContaining(["--list-models", "--offline", "--no-mcp", "--no-context-files", "--no-extensions"]),
        );
        callback(null, table);
      });
      expect(await readPiAiModels({ PI_CODING_AGENT_DIR: original, NODE_OPTIONS: "unsafe" })).toHaveLength(2);
      await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
      execute.mockImplementation((_file, _args, options, callback) => {
        cwd = options.cwd;
        callback(new Error("timed out"), "");
      });
      expect(await readPiAiModels({ PI_CODING_AGENT_DIR: original })).toEqual([]);
      await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(original, { recursive: true, force: true });
    }
  });
});
