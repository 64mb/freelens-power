import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on("finish", () => {
      const content = JSON.stringify({ text: "確認 🔋", tool: null });
      const data = Buffer.from(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: content } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
      );
      const position = data.indexOf(Buffer.from("確")) + 1;
      child.stdout.write(data.subarray(0, position));
      child.stdout.end(data.subarray(position));
      child.emit("close", 0);
    });
    return child;
  },
}));

import { runAiChat } from "./ai";

describe("Codex output stream", () => {
  it("preserves multibyte text split across stdout chunks", async () => {
    const result = await runAiChat(
      { messages: [{ role: "user", text: "Hello" }], context: {}, model: "", speed: "default" },
      () => {
        throw new Error("No cluster requested");
      },
    );
    expect(result.text).toBe("確認 🔋");
  });
});
