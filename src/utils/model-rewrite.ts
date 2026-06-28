/**
 * 响应中的 model 字段重写工具。
 *
 * 当用户调用模型分组别名（如 tier:advanced）时，网关内部会解析为真实模型执行，
 * 但返回给客户端的响应里 model 字段需要改回组别名，保持请求/响应一致。
 *
 * - 非流式 JSON 响应：直接解析 JSON 替换 model 字段。
 * - SSE 流式响应：用 TransformStream 逐事件解析并替换 model。
 */

/** 重写非流式 JSON 响应的 model 字段 */
export async function rewriteModelInJsonResponse(response: Response, targetModel: string): Promise<Response> {
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
    (body as Record<string, unknown>).model = targetModel;
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
  if (!response.body) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, separatorIndex + 2);
        buffer = buffer.slice(separatorIndex + 2);
        controller.enqueue(encoder.encode(rewriteSseEvent(event, targetModel)));
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(rewriteSseEvent(buffer, targetModel)));
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

/**
 * 处理单个 SSE 事件（可能包含多行 data:），把每行 JSON 中的 model 字段替换为目标值。
 * `data: [DONE]` 原样保留。
 */
function rewriteSseEvent(event: string, targetModel: string): string {
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
        if (parsed && typeof parsed === "object" && "model" in parsed) {
          parsed.model = targetModel;
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
