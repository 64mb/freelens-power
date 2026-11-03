import { getCACertificates } from "node:tls";
import { net } from "electron";
import WebSocket from "ws";
import { CODEX_API_MODELS, CODEX_API_REASONING_EFFORTS } from "../common/ai-models";
import { readAiApiKey } from "./ai-api-key";

import type { AiFailureCode } from "../common/ai";

const maximumResponseBytes = 2 * 1024 * 1024;
const maximumEventBytes = 1024 * 1024;
const maximumTextBytes = 512 * 1024;
const maximumArgumentsBytes = 65536;

type ApiItem = Record<string, any>;

export class CodexApiError extends Error {
  constructor(readonly failureCode: AiFailureCode) {
    super("AI API request failed");
    this.name = "CodexApiError";
  }
}

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function transportCodes(failure: unknown): unknown[] {
  const error = errorRecord(failure);
  const chromium =
    typeof error.message === "string" && /^net::[A-Z_]+$/.test(error.message) ? error.message.slice(5) : undefined;
  return [error.code, errorRecord(error.cause).code, chromium];
}

function tlsFailure(failure: unknown): boolean {
  return transportCodes(failure).some(
    (code) =>
      typeof code === "string" &&
      [
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "ERR_CERT_AUTHORITY_INVALID",
        "ERR_CERT_COMMON_NAME_INVALID",
        "ERR_CERT_DATE_INVALID",
        "ERR_CERT_INVALID",
      ].includes(code),
  );
}

function networkFailure(failure: unknown): boolean {
  return transportCodes(failure).some(
    (code) =>
      typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ECONNABORTED",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ENETDOWN",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "ERR_NETWORK",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT",
        "ERR_PROXY_CONNECTION_FAILED",
        "ERR_TUNNEL_CONNECTION_FAILED",
        "ERR_NAME_NOT_RESOLVED",
        "ERR_CONNECTION_REFUSED",
        "ERR_CONNECTION_RESET",
        "ERR_INTERNET_DISCONNECTED",
        "ERR_NETWORK_CHANGED",
        "ERR_ADDRESS_UNREACHABLE",
        "ERR_TIMED_OUT",
        "ERR_CONNECTION_TIMED_OUT",
      ].includes(code),
  );
}

function apiFailure(status: number | undefined, payload: unknown): CodexApiError {
  const envelope = errorRecord(payload);
  const nested = errorRecord(envelope.error ?? errorRecord(envelope.response).error);
  const error = Object.keys(nested).length ? nested : envelope;
  const field = (value: unknown) => (typeof value === "string" && value.length <= 100 ? value : "");
  const code = field(error.code) || field(error.type);
  const type = field(error.type);
  const param = field(error.param);
  const eventStatus = envelope.status ?? envelope.status_code ?? error.status ?? error.status_code;
  const httpStatus =
    status ?? (typeof eventStatus === "number" && Number.isInteger(eventStatus) ? eventStatus : undefined);
  let failureCode: AiFailureCode = "API_FAILURE";
  if (["invalid_api_key", "invalid_authentication", "authentication_error"].includes(code) || httpStatus === 401)
    failureCode = "API_AUTHENTICATION";
  else if (code === "unsupported_country_region_territory") failureCode = "API_REGION_UNSUPPORTED";
  else if (["model_not_found", "model_not_available", "model_access_denied"].includes(code))
    failureCode = "API_MODEL_UNAVAILABLE";
  else if (
    [
      "insufficient_quota",
      "credit_balance_exhausted",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
      "billing_hard_limit_reached",
      "billing_not_active",
      "quota_exceeded",
    ].includes(code) ||
    type === "insufficient_quota"
  )
    failureCode = "API_QUOTA";
  else if (
    ["previous_response_not_found", "websocket_connection_limit_reached", "websocket_stream_limit_reached"].includes(
      code,
    )
  )
    failureCode = "API_SESSION_EXPIRED";
  else if (["rate_limit_exceeded", "slow_down"].includes(code) || type === "rate_limit_error")
    failureCode = "API_RATE_LIMIT";
  else if (code === "context_length_exceeded") failureCode = "INPUT_LIMIT";
  else if (param === "service_tier") failureCode = "API_SERVICE_TIER";
  else if (httpStatus === 403 || ["insufficient_permissions", "permission_denied", "permission_error"].includes(code))
    failureCode = "API_PERMISSION";
  else if (
    type === "invalid_request_error" ||
    [
      "invalid_request_error",
      "unsupported_parameter",
      "unknown_parameter",
      "unsupported_value",
      "invalid_value",
    ].includes(code) ||
    httpStatus === 400 ||
    httpStatus === 422
  ) {
    if (param === "model") failureCode = "API_MODEL_UNAVAILABLE";
    else if (param === "reasoning.mode") failureCode = "API_REASONING_MODE_UNSUPPORTED";
    else if (param === "reasoning.effort") failureCode = "API_REASONING_EFFORT_UNSUPPORTED";
    else if (param === "text.verbosity") failureCode = "API_VERBOSITY_UNSUPPORTED";
    else if (
      param === "tools" ||
      param.startsWith("tools[") ||
      param.startsWith("tools.") ||
      param === "parallel_tool_calls" ||
      param === "tool_choice"
    )
      failureCode = "API_TOOLS_UNSUPPORTED";
    else if (["unsupported_parameter", "unknown_parameter", "unsupported_value"].includes(code))
      failureCode = "API_OPTION_UNSUPPORTED";
    else failureCode = "API_REQUEST_REJECTED";
  } else if (httpStatus === 404) failureCode = "API_MODEL_UNAVAILABLE";
  else if (httpStatus === 429) failureCode = "API_RATE_LIMIT";
  else if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    ["server_error", "server_is_overloaded", "service_unavailable_error"].includes(code)
  )
    failureCode = "API_SERVER_UNAVAILABLE";
  return new CodexApiError(failureCode);
}

async function httpFailure(response: Response, signal: AbortSignal): Promise<CodexApiError> {
  if (!response.body) return apiFailure(response.status, undefined);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  const timeout = setTimeout(cancel, 3000);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) return apiFailure(response.status, undefined);
      chunks.push(chunk.value);
    }
    return apiFailure(response.status, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return apiFailure(response.status, undefined);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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
    if (event.type === "freelens.transport.tls") throw new CodexApiError("API_TLS");
    if (event.type === "freelens.transport.interrupted") throw new CodexApiError("API_STREAM_INTERRUPTED");
    if (event.type === "freelens.transport.limit") throw new Error("AI response exceeded the size limit");
    if (event.type === "freelens.transport.invalid") return invalid();
    if (event.type === "freelens.transport.internal") throw new CodexApiError("API_FAILURE");
    if (["error", "response.failed"].includes(event.type)) throw apiFailure(undefined, event);
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
  } catch (failure) {
    if (tlsFailure(failure)) throw new CodexApiError("API_TLS");
    if (networkFailure(failure)) throw new CodexApiError("API_STREAM_INTERRUPTED");
    throw failure;
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
      ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])],
      rejectUnauthorized: true,
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
    const failed = (failure?: unknown) => {
      cleanup();
      socket.terminate();
      reject(new CodexApiError(tlsFailure(failure) ? "API_TLS" : "API_NETWORK"));
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
  const { stream: _stream, ...request } = body;
  const payload = JSON.stringify({ type: "response.create", ...request });
  let detach = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let finished = false;
        const cleanup = () => {
          socket.removeListener("message", message);
          socket.removeListener("error", failed);
          socket.removeListener("close", closed);
        };
        const finish = (type: "interrupted" | "limit" | "invalid" | "internal" | "tls") => {
          if (finished) return;
          finished = true;
          cleanup();
          controller.enqueue(Buffer.from(`data: {"type":"freelens.transport.${type}"}\n\n`));
          controller.close();
        };
        const failed = (failure?: unknown) => {
          finish(tlsFailure(failure) ? "tls" : "interrupted");
        };
        const closed = () => {
          finish("interrupted");
        };
        const message = (data: WebSocket.RawData, binary: boolean) => {
          if (finished) return;
          const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          if (binary) {
            finish("invalid");
            return;
          }
          const framedBytes = raw.length + 8;
          if (raw.length > maximumEventBytes || framedBytes > (controller.desiredSize ?? 0)) {
            finish("limit");
            return;
          }
          controller.enqueue(Buffer.concat([Buffer.from("data: "), raw, Buffer.from("\n\n")]));
        };
        detach = () => {
          finished = true;
          cleanup();
        };
        socket.on("message", message);
        socket.on("error", failed);
        socket.on("close", closed);
        try {
          socket.send(payload, (error) => {
            if (error) failed(error);
          });
        } catch (failure) {
          finish(
            tlsFailure(failure)
              ? "tls"
              : socket.readyState !== WebSocket.OPEN || networkFailure(failure)
                ? "interrupted"
                : "internal",
          );
        }
      },
      cancel() {
        detach();
      },
    },
    { highWaterMark: maximumResponseBytes, size: (chunk) => chunk.byteLength },
  );
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
        reasoning: { effort: reasoningEffort || "medium" },
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
        if (socket && socket.readyState !== WebSocket.OPEN) throw new CodexApiError("API_NETWORK");
        const response = socket
          ? socketResponse(socket, {
              ...requestBody,
              input: previousId ? input.slice(sentItems) : input,
              ...(previousId ? { previous_response_id: previousId } : {}),
            })
          : await net.fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              redirect: "error",
              credentials: "omit",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
              },
              body,
            });
        if (!response.ok) throw await httpFailure(response, controller.signal);
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
        if (failure instanceof CodexApiError) throw failure;
        if (
          failure instanceof SyntaxError ||
          (failure instanceof TypeError && failure.message.includes("encoded data"))
        )
          return invalid();
        if (failure instanceof Error && /^(AI API |AI returned |AI response exceeded)/.test(failure.message))
          throw failure;
        throw new CodexApiError(
          tlsFailure(failure) ? "API_TLS" : networkFailure(failure) ? "API_NETWORK" : "API_FAILURE",
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
}
