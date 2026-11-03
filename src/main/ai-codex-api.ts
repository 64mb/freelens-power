import WebSocket from "ws";
import { CODEX_API_MODELS, CODEX_API_REASONING_EFFORTS } from "../common/ai-models";
import { readAiApiKey } from "./ai-api-key";

const maximumResponseBytes = 2 * 1024 * 1024;
const maximumEventBytes = 1024 * 1024;
const maximumTextBytes = 512 * 1024;
const maximumArgumentsBytes = 65536;

type ApiItem = Record<string, any>;

function invalid(): never {
  throw new Error("AI returned an invalid response");
}

function parseReadArguments(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximumArgumentsBytes) return invalid();
  const read = JSON.parse(value);
  const fields = ["method", "resource", "namespace", "name", "ref", "apiVersion", "kind"];
  if (
    !read ||
    typeof read !== "object" ||
    Array.isArray(read) ||
    Object.keys(read).length !== fields.length ||
    !["pods", "nodes", "resources", "logs", "dashboard"].includes(read.method) ||
    !fields.every(
      (field) =>
        Object.hasOwn(read, field) && (field === "method" || read[field] === null || typeof read[field] === "string"),
    )
  )
    return invalid();
  return read;
}

async function readResponseStream(
  response: Response,
  controller: AbortController,
  finalAnswer: boolean,
  onText?: (text: string) => void,
): Promise<{ id?: string; serviceTier?: string; output: ApiItem[]; text: string; calls: ApiItem[]; reads: unknown[] }> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return invalid();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  if (controller.signal.aborted) cancel();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let dataBytes = 0;
  let bytes = 0;
  let events = 0;
  let completed: ApiItem | undefined;
  let streamed = "";
  let textBytes = 0;
  let lastPublished = -Infinity;
  const argumentBytes = new Map<number, number>();
  const functionItems = new Set<number>();
  const doneItems = new Map<string, ApiItem>();
  const accept = () => {
    if (!data.length) return;
    const raw = data.join("\n");
    data = [];
    dataBytes = 0;
    if (raw === "[DONE]") {
      if (!completed) throw new Error("AI returned an incomplete response");
      return;
    }
    if (++events > 16384 || completed) return invalid();
    const event = JSON.parse(raw);
    if (!event || typeof event !== "object" || typeof event.type !== "string") return invalid();
    if (["error", "response.failed"].includes(event.type)) throw new Error("AI API request failed");
    if (["response.incomplete", "response.refusal.delta", "response.refusal.done"].includes(event.type))
      throw new Error("AI returned an incomplete response");
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") return invalid();
      textBytes += Buffer.byteLength(event.delta);
      if (textBytes > maximumTextBytes) throw new Error("AI response exceeded the size limit");
      streamed += event.delta;
      const now = Date.now();
      if (now - lastPublished >= 30) {
        lastPublished = now;
        onText?.(streamed);
      }
    } else if (event.type === "response.output_item.added") {
      const item = event.item;
      if (!item || !["message", "reasoning", "function_call"].includes(item.type)) return invalid();
      if (item.type === "function_call") {
        if (finalAnswer || item.name !== "read_context" || !Number.isInteger(event.output_index)) return invalid();
        functionItems.add(event.output_index);
        if (functionItems.size > 4) return invalid();
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (finalAnswer || typeof event.delta !== "string" || !Number.isInteger(event.output_index)) return invalid();
      const next = (argumentBytes.get(event.output_index) ?? 0) + Buffer.byteLength(event.delta);
      argumentBytes.set(event.output_index, next);
      if (next > maximumArgumentsBytes || argumentBytes.size > 4)
        throw new Error("AI response exceeded the size limit");
    } else if (event.type === "response.output_item.done") {
      if (
        !event.item ||
        typeof event.item.id !== "string" ||
        !["message", "reasoning", "function_call"].includes(event.item.type)
      )
        return invalid();
      if (doneItems.size >= 16) return invalid();
      doneItems.set(event.item.id, event.item);
    } else if (event.type === "response.completed") {
      if (event.response?.status !== "completed" || !Array.isArray(event.response.output)) return invalid();
      completed = event.response;
    }
  };
  const line = (value: string) => {
    if (value === "") {
      accept();
      return;
    }
    if (!value.startsWith("data:")) return;
    const content = value.slice(5).replace(/^ /, "");
    dataBytes += Buffer.byteLength(content);
    if (dataBytes > maximumEventBytes) throw new Error("AI response exceeded the size limit");
    data.push(content);
  };
  try {
    while (!completed) {
      const chunk = await reader.read();
      if (controller.signal.aborted) throw new Error("AI request cancelled");
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer) line(buffer);
        accept();
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumResponseBytes) throw new Error("AI response exceeded the size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      while (!completed) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (buffer[index] === "\r" && index === buffer.length - 1)) break;
        const skip = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        const value = buffer.slice(0, index);
        buffer = buffer.slice(index + skip);
        line(value);
      }
      if (Buffer.byteLength(buffer) > maximumEventBytes) throw new Error("AI response exceeded the size limit");
    }
    if (!completed) throw new Error("AI returned an incomplete response");
    if (completed.output.length > 16) return invalid();
    const output: ApiItem[] = completed.output.map((item: ApiItem) =>
      item?.type === "reasoning" && typeof item.id === "string" && doneItems.get(item.id)?.encrypted_content
        ? doneItems.get(item.id)!
        : item,
    );
    const calls: ApiItem[] = [];
    const reads: unknown[] = [];
    let text = "";
    const ids = new Set<string>();
    for (const item of output) {
      if (!item || typeof item !== "object") return invalid();
      if (item.type === "function_call") {
        if (
          finalAnswer ||
          item.name !== "read_context" ||
          typeof item.call_id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,200}$/.test(item.call_id) ||
          ids.has(item.call_id) ||
          calls.length >= 4
        )
          return invalid();
        ids.add(item.call_id);
        reads.push(parseReadArguments(item.arguments));
        calls.push(item);
      } else if (item.type === "message") {
        if (item.role !== "assistant" || !Array.isArray(item.content)) return invalid();
        for (const content of item.content) {
          if (content?.type !== "output_text" || typeof content.text !== "string") return invalid();
          text += content.text;
        }
      } else if (item.type !== "reasoning") return invalid();
    }
    if (Buffer.byteLength(text) > maximumTextBytes) throw new Error("AI response exceeded the size limit");
    if (streamed && streamed !== text) return invalid();
    if (!calls.length && !text) return invalid();
    return { id: completed.id, serviceTier: completed.service_tier, output, text, calls, reads };
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function connectSocket(key: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://api.openai.com/v1/responses", {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: maximumResponseBytes,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
      followRedirects: false,
    });
    socket.on("error", () => {});
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeListener("open", opened);
      socket.removeListener("error", failed);
      socket.removeListener("close", failed);
      socket.removeListener("unexpected-response", failed);
    };
    const failed = () => {
      cleanup();
      socket.terminate();
      reject(new Error("AI API request failed"));
    };
    const abort = () => {
      cleanup();
      socket.terminate();
      reject(new Error("AI request cancelled"));
    };
    const opened = () => {
      cleanup();
      resolve(socket);
    };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", failed);
    socket.once("unexpected-response", failed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function socketResponse(socket: WebSocket, body: Record<string, unknown>): Response {
  let detach = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        socket.removeListener("message", message);
        socket.removeListener("error", failed);
        socket.removeListener("close", closed);
      };
      const failed = () => {
        cleanup();
        controller.error(new Error("AI API request failed"));
      };
      const closed = () => {
        cleanup();
        controller.close();
      };
      const message = (data: WebSocket.RawData, binary: boolean) => {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (binary || raw.length > maximumEventBytes || (controller.desiredSize ?? 0) < -16) {
          failed();
          return;
        }
        controller.enqueue(Buffer.concat([Buffer.from("data: "), raw, Buffer.from("\n\n")]));
      };
      detach = cleanup;
      socket.on("message", message);
      socket.on("error", failed);
      socket.on("close", closed);
      try {
        const { stream: _stream, ...request } = body;
        socket.send(JSON.stringify({ type: "response.create", ...request }), (error) => {
          if (error) failed();
        });
      } catch {
        failed();
      }
    },
    cancel() {
      detach();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

export function createCodexApiSession(
  prompt: string,
  parameters: unknown,
  model: string,
  reasoningEffort = "",
  options: { webSocket?: boolean; serviceTier?: "default" | "fast" | "ultrafast" } = {},
) {
  const selectedModel = model || CODEX_API_MODELS[0].id;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(selectedModel) ||
    (reasoningEffort && !CODEX_API_REASONING_EFFORTS.includes(reasoningEffort))
  )
    throw new Error("Invalid AI request");
  const serviceTier = options.serviceTier ?? "default";
  if (!["default", "fast", "ultrafast"].includes(serviceTier)) throw new Error("Invalid AI request");
  let key: string | undefined;
  let socket: WebSocket | undefined;
  let useSocket = options.webSocket === true;
  let previousId: string | undefined;
  let sentItems = 0;
  const input: ApiItem[] = [{ role: "user", content: prompt }];
  let pendingCalls: ApiItem[] = [];
  const callIds = new Set<string>();
  let turns = 0;
  return {
    close(): void {
      socket?.terminate();
      socket = undefined;
      key = undefined;
    },
    addResults(results: readonly unknown[]): void {
      if (!pendingCalls.length || results.length !== pendingCalls.length) return invalid();
      for (let index = 0; index < results.length; index++) {
        input.push({
          type: "function_call_output",
          call_id: pendingCalls[index].call_id,
          output: JSON.stringify(results[index]),
        });
      }
      pendingCalls = [];
    },
    async next(finalAnswer: boolean, signal?: AbortSignal, onText?: (text: string) => void): Promise<string> {
      if (pendingCalls.length || ++turns > 7) return invalid();
      if (finalAnswer)
        input.push({
          role: "user",
          content:
            "The read budget is exhausted. Answer now from the evidence already provided. Distinguish unavailable and missing evidence. Do not request further reads or invent results.",
        });
      const requestBody = {
        model: selectedModel,
        store: false,
        stream: true,
        service_tier: serviceTier,
        include: ["reasoning.encrypted_content"],
        input,
        max_output_tokens: 12000,
        reasoning: { mode: "standard", effort: reasoningEffort || "medium" },
        text: { verbosity: "low" },
        parallel_tool_calls: true,
        tools: finalAnswer
          ? []
          : [
              {
                type: "function",
                name: "read_context",
                description:
                  "Read bounded Kubernetes or configured dashboard evidence through the read-only broker. Request at most four independent reads in parallel. Never request shell, filesystem, arbitrary network or write actions.",
                strict: true,
                parameters,
              },
            ],
        ...(finalAnswer ? { tool_choice: "none" } : {}),
      };
      const body = JSON.stringify(requestBody);
      if (Buffer.byteLength(body) > maximumResponseBytes)
        throw new Error("Conversation is too large. Start a new conversation");
      signal?.throwIfAborted();
      key ??= await readAiApiKey();
      signal?.throwIfAborted();
      if (!key) throw new Error("AI API authentication failed");
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 120000);
      try {
        if (useSocket && !socket) {
          try {
            socket = await connectSocket(key, controller.signal);
          } catch (failure) {
            if (controller.signal.aborted || previousId) throw failure;
            useSocket = false;
          }
        }
        if (socket && socket.readyState !== WebSocket.OPEN) throw new Error("AI API request failed");
        const response = socket
          ? socketResponse(socket, {
              ...requestBody,
              input: previousId ? input.slice(sentItems) : input,
              ...(previousId ? { previous_response_id: previousId } : {}),
            })
          : await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
              },
              body,
            });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) throw new Error("AI API authentication failed");
          if (response.status === 429) throw new Error("AI API rate limit reached");
          throw new Error("AI API request failed");
        }
        const result = await readResponseStream(response, controller, finalAnswer, onText);
        if (socket && (typeof result.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.id))) return invalid();
        if (signal?.aborted) throw new Error("AI request cancelled");
        if (timedOut) throw new Error("AI request timed out");
        for (const call of result.calls) {
          if (callIds.has(call.call_id)) return invalid();
          callIds.add(call.call_id);
        }
        input.push(...result.output);
        if (socket) {
          previousId = result.id;
          sentItems = input.length;
        }
        pendingCalls = result.calls;
        return JSON.stringify({
          tool: result.reads.length ? result.reads : null,
          text: result.calls.length ? "" : result.text,
        });
      } catch (failure) {
        if (signal?.aborted) throw new Error("AI request cancelled");
        if (timedOut) throw new Error("AI request timed out");
        if (
          failure instanceof SyntaxError ||
          (failure instanceof TypeError && failure.message.includes("encoded data"))
        )
          return invalid();
        if (failure instanceof Error && /^(AI API |AI returned |AI response exceeded)/.test(failure.message))
          throw failure;
        throw new Error("AI API request failed");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
}
