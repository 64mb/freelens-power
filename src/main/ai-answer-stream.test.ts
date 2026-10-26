import { describe, expect, it } from "vitest";
import { createAiAnswerStream } from "./ai-answer-stream";

const event = (value: unknown) => `${JSON.stringify(value)}\n`;
const delta = (text: string, index = 0) =>
  event({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
const start = event({
  type: "stream_event",
  event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
});

describe("safe AI answer stream", () => {
  it("emits Claude final text incrementally across escaped JSON boundaries", () => {
    const texts: string[] = [];
    const stream = createAiAnswerStream("claude", (text) => texts.push(text));
    stream(start);
    stream(delta('{"tool":null,"text":"Hello'));
    expect(texts).toEqual(["Hello"]);
    stream(delta("\\n\\uD83D"));
    expect(texts.at(-1)).toBe("Hello\n");
    stream(delta('\\uDE80 world"}'));
    expect(texts.at(-1)).toBe("Hello\n🚀 world");
  });

  it("withholds tool payloads, reasoning and text before the final discriminator", () => {
    const texts: string[] = [];
    const stream = createAiAnswerStream("claude", (text) => texts.push(text));
    stream(
      event({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "private reasoning" },
        },
      }),
    );
    stream(delta("private reasoning", 1));
    stream(start);
    stream(delta('{"text":"intermediate plan","tool":'));
    expect(texts).toEqual([]);
    stream(delta('{"method":"pods"}}'));
    expect(texts).toEqual([]);
    stream(start);
    stream(delta('{"text":"Final answer","tool":null}'));
    expect(texts).toEqual(["Final answer"]);
  });

  it("buffers split provider event lines and ignores malformed events", () => {
    const texts: string[] = [];
    const stream = createAiAnswerStream("codex", (text) => texts.push(text));
    stream("not json\n");
    stream(event({ type: "item.completed", item: { type: "reasoning", text: "private reasoning" } }));
    const final = event({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ tool: null, text: "Answer" }) },
    });
    stream(final.slice(0, 9));
    expect(texts).toEqual([]);
    stream(final.slice(9));
    expect(texts).toEqual(["Answer"]);
  });
});
