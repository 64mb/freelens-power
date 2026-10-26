// only an explicit [tool: null] permits exposing answer text from a model response
export function createAiAnswerStream(provider: string, onText: (text: string) => void): (chunk: string) => void {
  let lines = "";
  let response = "";
  let emitted = "";
  let textBlock: number | undefined;
  const publish = (input: string) => {
    let text: string | undefined;
    try {
      const value = JSON.parse(input);
      if (
        value &&
        value.tool === null &&
        typeof value.text === "string" &&
        Object.keys(value).every((key) => key === "tool" || key === "text")
      )
        text = value.text;
    } catch {
      // partial text is safe only after the final-answer discriminator precedes it
      const match = /^\s*\{\s*"tool"\s*:\s*null\s*,\s*"text"\s*:\s*"/.exec(input);
      if (match) {
        const value = input.slice(match[0].length);
        let decoded = "";
        for (let i = 0; i < value.length; i++) {
          const character = value[i];
          if (character === '"') break;
          if (character.charCodeAt(0) < 32) return;
          if (character !== "\\") {
            decoded += character;
            continue;
          }
          const escape = value[++i];
          if (escape === undefined) break;
          if (escape === "u") {
            const hex = value.slice(i + 1, i + 5);
            if (hex.length < 4) break;
            if (!/^[\da-f]{4}$/i.test(hex)) return;
            decoded += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else {
            const escapes: Record<string, string> = {
              '"': '"',
              "\\": "\\",
              "/": "/",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t",
            };
            if (!(escape in escapes)) return;
            decoded += escapes[escape];
          }
        }
        // a trailing high surrogate may still be waiting for its low surrogate
        text = decoded.replace(/[\uD800-\uDBFF]$/, "");
      }
    }
    if (text !== undefined && text !== emitted && text.startsWith(emitted)) {
      emitted = text;
      onText(text);
    }
  };
  return (chunk) => {
    lines += chunk;
    let newline: number;
    while ((newline = lines.indexOf("\n")) >= 0) {
      const line = lines.slice(0, newline);
      lines = lines.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (provider === "codex") {
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message" &&
            typeof event.item.text === "string"
          )
            publish(event.item.text);
        } else if (event.type === "stream_event") {
          const item = event.event;
          if (item?.type === "content_block_start" && item.content_block?.type === "text") {
            textBlock = item.index;
            response = typeof item.content_block.text === "string" ? item.content_block.text : "";
            publish(response);
          } else if (
            item?.type === "content_block_delta" &&
            item.index === textBlock &&
            item.delta?.type === "text_delta" &&
            typeof item.delta.text === "string"
          ) {
            response += item.delta.text;
            publish(response);
          }
        } else if (
          event.type === "result" &&
          !event.is_error &&
          event.subtype === "success" &&
          typeof event.result === "string"
        )
          publish(event.result);
      } catch {
        /* malformed provider events never become visible text */
      }
    }
  };
}
