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
    "image": {
      execution_mode: "async_polling",
      result_delivery: "polling",
      poll_interval_seconds: 2,
      supports_image_input: true,
      supports_mask: true,
      supports_strength: true,
      supported_image_modes: ["image-to-image", "inpaint"],
      parameters: [
        { name: "prompt", type: "string", required: true, description: "生图提示词", maps_to: "prompt" },
        { name: "image", type: "string", description: "参考图片 URL 或 base64", maps_to: "reference_image" },
        { name: "mask", type: "string", description: "局部重绘遮罩", maps_to: "mask_image" },
        { name: "strength", type: "number", description: "重绘强度 0~1", maps_to: "strength" },
        { name: "width", type: "integer", default: 1024, description: "图片宽度（像素）", maps_to: "width" },
        { name: "height", type: "integer", default: 1024, description: "图片高度（像素）", maps_to: "height" },
        { name: "image_count", type: "integer", default: 1, description: "生成图片数量", maps_to: "num_images_per_prompt", aliases: ["n"] },
        { name: "steps", type: "integer", default: 30, description: "迭代/采样步数", maps_to: "num_inference_steps", aliases: ["num_inference_steps"] },
        { name: "guidance_scale", type: "number", default: 1.0, description: "提示词引导强度", maps_to: "cfg_scale", aliases: ["cfg_scale"] },
        { name: "negative_prompt", type: "string", default: "", description: "反向提示词", maps_to: "negative_prompt" },
        { name: "seed", type: "integer", description: "随机种子", maps_to: "seed" },
        { name: "provider_params", type: "object", description: "Moark 原生参数透传区" }
      ]
    }
  }
};

const DEFAULT_BASE_URL = "https://ai.gitee.com/v1";
const LEGACY_BASE_URLS = new Set([
  "https://ai.gitee.com/api/v1",
  "https://api.gitee.com/v1",
]);
const DEFAULT_CREATE_PATH = "/async/images/generations";
const DEFAULT_POLL_PATH = "/task/{task_id}";

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
  code?: string;
  message?: string;
  task_id?: string;
  status?: string;
  data?: {
    task_id?: string;
    status?: string;
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

  const upstreamUrl = getCreateUrl(context);

  const upstreamRequest = buildMoarkImageRequest(request, context.route.provider_model);

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
  const providerTaskId = firstString(data.data?.task_id, data.task_id);
  const providerStatus = firstString(data.data?.status, data.status, "queued");

  if (providerTaskId) {
    return jsonResponse(
      {
        id: providerTaskId,
        object: "task",
        status: providerStatus,
        provider_task_id: providerTaskId,
        provider_execution_mode: "async_polling",
        code: data.code,
        message: data.message
      },
      {
        status: 202,
        headers: {
          "X-Request-Id": context.request_id
        }
      }
    );
  }

  throw upstreamError(
    data.error || data.message || "Unexpected response from Moark API",
    500,
    data.code || "upstream_error"
  );
}

function buildMoarkImageRequest(request: ImageGenerationRequest, providerModel: string): Record<string, unknown> {
  const providerParams = objectParam(request.provider_params);
  const upstreamRequest: Record<string, unknown> = {
    ...providerParams,
    model: providerModel,
    prompt: request.prompt,
    num_images_per_prompt: numberParam(request.image_count, request.n, request.num_images_per_prompt, providerParams.num_images_per_prompt) ?? 1,
    num_inference_steps: numberParam(request.steps, request.num_inference_steps, providerParams.num_inference_steps) ?? 30,
    cfg_scale: numberParam(request.guidance_scale, request.cfg_scale, providerParams.cfg_scale) ?? 1.0,
    negative_prompt: stringParam(request.negative_prompt, providerParams.negative_prompt) ?? "",
    seed: numberParam(request.seed, providerParams.seed),
    lora_weights: request.lora_weights ?? providerParams.lora_weights
  };

  const width = numberParam(request.width, providerParams.width);
  const height = numberParam(request.height, providerParams.height);
  upstreamRequest.width = width ?? 1024;
  upstreamRequest.height = height ?? 1024;

  // 图生图参数映射
  const imageValue = Array.isArray(request.image) ? request.image[0] : request.image;
  if (imageValue) {
    upstreamRequest.reference_image = normalizeImageForUpstream(imageValue);
  }
  if (request.mask) {
    upstreamRequest.mask_image = normalizeImageForUpstream(request.mask);
  }
  if (typeof request.strength === "number") {
    upstreamRequest.strength = request.strength;
  }

  Object.keys(upstreamRequest).forEach((key) => {
    if (upstreamRequest[key] === undefined) {
      delete upstreamRequest[key];
    }
  });

  return upstreamRequest;
}

/**
 * 将图片输入（URL 或 base64）转换为上游可接受的格式。
 * URL 直接传递，base64 传递完整 data URI。
 */
function normalizeImageForUpstream(image: string): string {
  return image;
}

function objectParam(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function numberParam(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function stringParam(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

async function mapUpstreamError(response: Response): Promise<Error> {
  let message = `Upstream provider returned ${response.status}`;
  let code = "upstream_error";

  try {
    const body = (await response.clone().json()) as MoarkAsyncResponse;
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
  code?: string;
  message?: string;
  task_id?: string;
  status?: string;
  output?: MoarkOutput;
  data?: {
    task_id?: string;
    status?: string;
    output?: MoarkOutput;
    error?: string;
  };
  error?: string;
}

type MoarkOutput = MoarkOutputItem | MoarkOutputItem[];

interface MoarkOutputItem {
  url?: string;
  file_url?: string;
  b64_json?: string;
  text_result?: string;
  [key: string]: unknown;
}

async function pollMoarkTask(providerTaskId: string, context: ProviderRequestContext): Promise<TaskPollResult> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const pollUrl = getPollUrl(context, providerTaskId);

  const upstream = await fetch(pollUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Request-Id": context.request_id
    }
  });

  if (!upstream.ok) {
    const errorDetail = await readMoarkErrorSummary(upstream);
    const errorMsg = errorDetail.message || `Upstream poll returned ${upstream.status}`;
    const rawBody = errorDetail.raw_body;
    // 上游返回非 2xx，判断是否为永久性失败
    if (upstream.status >= 400 && upstream.status < 500) {
      return {
        status: "failed",
        provider_status: "http_error",
        provider_response_code: errorDetail.code,
        http_status: upstream.status,
        message: errorMsg,
        poll_url: pollUrl,
        upstream_raw_body: rawBody,
        error: { message: errorMsg, http_status: upstream.status, code: errorDetail.code, poll_url: pollUrl, upstream_raw_body: rawBody }
      };
    }
    // 5xx 可能是临时故障，继续轮询
    return {
      status: "running",
      provider_status: "http_error",
      provider_response_code: errorDetail.code,
      http_status: upstream.status,
      message: errorMsg,
      poll_url: pollUrl,
      upstream_raw_body: rawBody
    };
  }

  const data = (await upstream.json()) as MoarkPollResponse;

  // 根据 Moark 状态码映射
  const statusMap: Record<string, TaskPollResult["status"]> = {
    queued: "queued",
    pending: "queued",
    running: "running",
    processing: "running",
    succeeded: "succeeded",
    success: "succeeded",
    completed: "succeeded",
    failed: "failed",
    error: "failed",
    canceled: "canceled",
    cancelled: "canceled"
  };

  const providerStatus = firstString(data.data?.status, data.status);
  const mappedStatus = statusMap[providerStatus?.toLowerCase() || ""] || "running";

  if (mappedStatus === "succeeded") {
    const output = normalizeOutput(data.data?.output ?? data.output);
    return {
      status: "succeeded",
      provider_status: providerStatus,
      provider_response_code: data.code,
      http_status: upstream.status,
      message: data.message,
      poll_url: pollUrl,
      output
    };
  }

  if (mappedStatus === "failed") {
    return {
      status: "failed",
      provider_status: providerStatus,
      provider_response_code: data.code,
      http_status: upstream.status,
      message: data.message,
      poll_url: pollUrl,
      error: {
        message: data.data?.error || data.error || data.message || "Upstream task failed",
        code: data.code
      }
    };
  }

  return {
    status: mappedStatus,
    provider_status: providerStatus,
    provider_response_code: data.code,
    http_status: upstream.status,
    message: data.message,
    poll_url: pollUrl
  };
}

function normalizeOutput(output: MoarkOutput | undefined): AsyncTaskOutputItem[] {
  if (!output) {
    return [];
  }

  const items = Array.isArray(output) ? output : [output];
  return items.map((item, index) => ({
    type: "image",
    url: item.url || item.file_url,
    b64_json: item.b64_json,
    text_result: item.text_result,
    index,
    source: "upstream" as const
  }));
}

async function readMoarkErrorSummary(response: Response): Promise<{ code?: string; message?: string; raw_body?: string }> {
  try {
    const body = (await response.clone().json()) as Partial<MoarkAsyncResponse>;
    return {
      code: body.code,
      message: body.error || body.message,
      raw_body: truncateString(JSON.stringify(body), 1000)
    };
  } catch {
    const text = await response.text().catch(() => "");
    const truncated = truncateString(text, 1000);
    return text ? { message: truncated, raw_body: truncated } : {};
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function getCreateUrl(context: ProviderRequestContext): string {
  const explicitUrl = getConfigString(context, "create_url") || getConfigString(context, "api_url");
  if (explicitUrl) {
    return explicitUrl;
  }

  const baseUrl = normalizeBaseUrl(context.credential.base_url || DEFAULT_BASE_URL);
  if (isCreateEndpoint(baseUrl)) {
    return baseUrl;
  }

  return joinUrl(baseUrl, getConfigString(context, "create_path") || DEFAULT_CREATE_PATH);
}

function getPollUrl(context: ProviderRequestContext, providerTaskId: string): string {
  const explicitUrl = getConfigString(context, "poll_url") || getConfigString(context, "status_url");
  if (explicitUrl) {
    return interpolateTaskId(explicitUrl, providerTaskId);
  }

  const baseUrl = normalizeBaseUrl(context.credential.base_url || DEFAULT_BASE_URL);
  const pollBaseUrl = isCreateEndpoint(baseUrl) ? parentUrl(baseUrl) : baseUrl;
  return joinUrl(pollBaseUrl, interpolateTaskId(getConfigString(context, "poll_path") || DEFAULT_POLL_PATH, providerTaskId));
}

function getConfigString(context: ProviderRequestContext, key: string): string | undefined {
  const value = context.credential.config?.[key] ?? context.route.config?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // 旧版 API 地址或只填了根域名，自动转为当前正确地址
  if (LEGACY_BASE_URLS.has(trimmed) || trimmed === "https://ai.gitee.com") {
    return DEFAULT_BASE_URL;
  }
  return baseUrl;
}

function interpolateTaskId(value: string, providerTaskId: string): string {
  return value.replace(/\{task_id\}/g, encodeURIComponent(providerTaskId));
}

function isCreateEndpoint(url: string): boolean {
  return /\/async\/images\/generations\/?$/.test(url);
}

function parentUrl(url: string): string {
  return url.replace(/\/[^/]+\/?$/, "");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function truncateString(value: string, maxLength: number): string {
  if (!value) return "";
  return value.length <= maxLength ? value : value.slice(0, maxLength) + "...";
}
