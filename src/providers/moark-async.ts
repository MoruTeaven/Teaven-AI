import { jsonResponse } from "../http/response";
import { upstreamError } from "../http/errors";
import type { AsyncTaskOutputItem, AsyncTaskRecord, Env, ImageGenerationRequest } from "../types";
import type { ProviderPlugin, ProviderPluginManifest, ProviderRequestContext, TaskPollResult } from "./types";

const MANIFEST: ProviderPluginManifest = {
  id: "moark-async",
  name: "Moark Async (Gitee AI)",
  version: "1.0.0",
  runtime: "in_process",
  capabilities: {
    "images.generations": {
      execution_mode: "async_polling",
      result_delivery: "polling",
      poll_interval_seconds: 2
    }
  }
};

export function createMoarkAsyncPlugin(_env: Env): ProviderPlugin {
  return {
    manifest: MANIFEST,
    createAdapter() {
      return {
        manifest: MANIFEST,
        async imageGenerations(request: ImageGenerationRequest, context: ProviderRequestContext): Promise<Response> {
          return forwardAsyncImageGeneration(request, context);
        },
        async pollTask(providerTaskId: string, _taskRecord: AsyncTaskRecord, context: ProviderRequestContext): Promise<TaskPollResult> {
          return pollMoarkTask(providerTaskId, context);
        }
      };
    }
  };
}

interface MoarkAsyncResponse {
  code: string;
  message: string;
  data?: {
    task_id: string;
    status: string;
  };
  error?: string;
}

async function forwardAsyncImageGeneration(
  request: ImageGenerationRequest,
  context: ProviderRequestContext
): Promise<Response> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const baseUrl = context.credential.base_url || "https://api.gitee.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/async/images/generations");

  // 构建上游请求，使用提供者的模型名称
  const upstreamRequest: Record<string, unknown> = {
    model: context.route.provider_model,
    prompt: request.prompt,
    n: request.n || 1,
    size: request.size,
    response_format: request.response_format || "url",
    quality: request.quality,
    style: request.style
  };

  // 移除undefined字段
  Object.keys(upstreamRequest).forEach((key) => {
    if (upstreamRequest[key] === undefined) {
      delete upstreamRequest[key];
    }
  });

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Request-Id": context.request_id
    },
    body: JSON.stringify(upstreamRequest),
    signal: context.signal
  });

  if (!upstream.ok) {
    throw await mapUpstreamError(upstream);
  }

  const data = (await upstream.json()) as MoarkAsyncResponse;

  // 模力方舟异步接口返回202 Accepted
  if (data.code === "200000" && data.data?.task_id) {
    return jsonResponse(
      {
        id: data.data.task_id,
        object: "task",
        status: data.data.status,
        provider_task_id: data.data.task_id,
        provider_execution_mode: "async_polling"
      },
      {
        status: 202,
        headers: {
          "X-Request-Id": context.request_id
        }
      }
    );
  }

  // 处理其他响应
  throw upstreamError(
    data.message || "Unexpected response from Moark API",
    500,
    data.code || "upstream_error"
  );
}

async function mapUpstreamError(response: Response): Promise<Error> {
  let message = `Upstream provider returned ${response.status}`;
  let code = "upstream_error";

  try {
    const body = (await response.json()) as MoarkAsyncResponse;
    if (body.message) {
      message = body.message;
    }
    if (body.code) {
      code = String(body.code);
    }
    if (body.error) {
      message = body.error;
    }
  } catch {
    const text = await response.text().catch(() => "");
    if (text) {
      message = text.slice(0, 500);
    }
  }

  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  return upstreamError(message, status, code);
}

interface MoarkPollResponse {
  code: string;
  message: string;
  data?: {
    task_id: string;
    status: string;
    output?: Array<{
      url?: string;
      b64_json?: string;
      [key: string]: unknown;
    }>;
    error?: string;
  };
}

async function pollMoarkTask(providerTaskId: string, context: ProviderRequestContext): Promise<TaskPollResult> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const baseUrl = context.credential.base_url || "https://api.gitee.com/v1";
  const pollUrl = joinUrl(baseUrl, `/async/images/generations/${providerTaskId}`);

  const upstream = await fetch(pollUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Request-Id": context.request_id
    }
  });

  if (!upstream.ok) {
    const errorMsg = `Upstream poll returned ${upstream.status}`;
    // 上游返回非 2xx，判断是否为永久性失败
    if (upstream.status >= 400 && upstream.status < 500) {
      return {
        status: "failed",
        error: { message: errorMsg, http_status: upstream.status }
      };
    }
    // 5xx 可能是临时故障，继续轮询
    return { status: "running" };
  }

  const data = (await upstream.json()) as MoarkPollResponse;

  // 根据 Moark 状态码映射
  const statusMap: Record<string, TaskPollResult["status"]> = {
    "queued": "queued",
    "running": "running",
    "processing": "running",
    "succeeded": "succeeded",
    "success": "succeeded",
    "completed": "succeeded",
    "failed": "failed",
    "error": "failed",
    "canceled": "canceled"
  };

  const mappedStatus = statusMap[data.data?.status?.toLowerCase() || ""] || "running";

  if (mappedStatus === "succeeded" && data.data?.output) {
    const output: AsyncTaskOutputItem[] = data.data.output.map((item, index) => ({
      type: "image",
      url: item.url,
      b64_json: item.b64_json,
      index,
      source: "upstream" as const
    }));
    return { status: "succeeded", output };
  }

  if (mappedStatus === "failed") {
    return {
      status: "failed",
      error: {
        message: data.data?.error || data.message || "Upstream task failed",
        code: data.code
      }
    };
  }

  return { status: mappedStatus };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
