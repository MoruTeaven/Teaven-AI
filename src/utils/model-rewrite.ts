/**
 * 响应中的 model 字段重写工具。
 *
 * 当用户调用模型分组别名（如 tier:advanced）时，网关内部会解析为真实模型执行，
 * 但返回给客户端的响应里 model 字段需要改回组别名，保持请求/响应一致。
 *
 * - 非流式 JSON 响应：直接解析 JSON 替换 model 字段。
 * - SSE 流式响应：用 TransformStream 逐事件解析并替换 model。
 */

export interface JsonResponsePatchOptions {
  targetModel?: string;
  fields?: Record<string, unknown>;
}

export interface StreamResponsePatchOptions extends JsonResponsePatchOptions {
  firstEventFields?: Record<string, unknown>;
  onComplete?: (usage: unknown | undefined) => void | Promise<void>;
}

/** 重写非流式 JSON 响应的 model 字段 */
export async function rewriteModelInJsonResponse(response: Response, targetModel: string): Promise<Response> {
  return patchJsonResponse(response, { targetModel });
}

/** 对非流式 JSON 响应做统一补丁：可改写 model，也可追加平台字段。 */
export async function patchJsonResponse(response: Response, options: JsonResponsePatchOptions): Promise<Response> {
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    return response;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response;
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const output = body as Record<string, unknown>;
    if (options.targetModel) {
      output.model = options.targetModel;
    }
    if (options.fields) {
      Object.assign(output, options.fields);
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * 重写 SSE 流式响应中的 model 字段。
 * OpenAI 流式格式：`data: {...}\n\n`，最后是 `data: [DONE]\n\n`。
 */
export function rewriteModelInStreamResponse(response: Response, targetModel: string): Response {
  return patchStreamResponse(response, { targetModel });
}

/** 对 SSE 流式响应做统一补丁：可改写 model、给首个 JSON chunk 追加字段，并在完成时回传 usage。 */
export function patchStreamResponse(response: Response, options: StreamResponsePatchOptions): Response {
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state: StreamPatchState = {
    injectedFirstEventFields: false,
    usage: undefined
  };

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, separatorIndex + 2);
        buffer = buffer.slice(separatorIndex + 2);
        controller.enqueue(encoder.encode(patchSseEvent(event, options, state)));
      }
    },
    async flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(patchSseEvent(buffer, options, state)));
      }
      if (options.onComplete) {
        try {
          await options.onComplete(state.usage);
        } catch (error) {
          console.error("failed to run stream completion hook", error);
        }
      }
    }
  });

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");

  return new Response(response.body.pipeThrough(transformStream), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

interface StreamPatchState {
  injectedFirstEventFields: boolean;
  usage: unknown | undefined;
}

/**
 * 处理单个 SSE 事件（可能包含多行 data:），把每行 JSON 中的 model 字段替换为目标值。
 * `data: [DONE]` 原样保留。
 */
function patchSseEvent(event: string, options: StreamResponsePatchOptions, state: StreamPatchState): string {
  const lines = event.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") {
        result.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object") {
          if (options.targetModel && "model" in parsed) {
            parsed.model = options.targetModel;
          }
          if ("usage" in parsed) {
            state.usage = parsed.usage;
          }
          if (!state.injectedFirstEventFields && options.firstEventFields) {
            Object.assign(parsed, options.firstEventFields);
            state.injectedFirstEventFields = true;
          }
          result.push("data: " + JSON.stringify(parsed));
          continue;
        }
      } catch {
        // 非 JSON，原样保留
      }
      result.push(line);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}
