import { jsonResponse } from "../http/response";
import { upstreamError } from "../http/errors";
import type { ChatCompletionRequest, Env, ImageGenerationRequest } from "../types";
import type { ProviderPlugin, ProviderPluginManifest, ProviderRequestContext } from "./types";

const MANIFEST: ProviderPluginManifest = {
  id: "openai-compatible",
  name: "OpenAI Compatible",
  version: "1.0.0",
  runtime: "in_process",
  capabilities: {
    "chat": {
      execution_mode: "stream_or_sync",
      supports_stream: true
    },
    "image": {
      execution_mode: "sync",
      supports_image_input: true,
      supports_mask: true,
      supports_strength: true,
      supported_image_modes: ["image-to-image", "inpaint"],
      parameters: [
        { name: "prompt", type: "string", required: true, description: "生图提示词", maps_to: "prompt" },
        { name: "image", type: "string", description: "参考图片 URL 或 base64", maps_to: "image" },
        { name: "mask", type: "string", description: "局部重绘遮罩", maps_to: "mask" },
        { name: "strength", type: "number", description: "重绘强度 0~1", maps_to: "strength" },
        { name: "size", type: "string", description: "图片尺寸", maps_to: "size" },
        { name: "width", type: "integer", description: "图片宽度，需和 height 一起传", maps_to: "size" },
        { name: "height", type: "integer", description: "图片高度，需和 width 一起传", maps_to: "size" },
        { name: "image_count", type: "integer", default: 1, description: "生成图片数量", maps_to: "n", aliases: ["n"] },
        { name: "response_format", type: "string", default: "url", description: "图片返回格式", maps_to: "response_format" },
        { name: "quality", type: "string", description: "图片质量，具体取值由上游模型决定", maps_to: "quality" },
        { name: "style", type: "string", description: "图片风格，具体取值由上游模型决定", maps_to: "style" },
        { name: "provider_params", type: "object", description: "OpenAI 兼容上游原生参数透传区" }
      ]
    }
  }
};

export function createOpenAICompatiblePlugin(_env: Env): ProviderPlugin {
  return {
    manifest: MANIFEST,
    createAdapter() {
      return {
        manifest: MANIFEST,
        async chatCompletions(request: ChatCompletionRequest, context: ProviderRequestContext): Promise<Response> {
          return forwardChatCompletion(request, context);
        },
        async imageGenerations(request: ImageGenerationRequest, context: ProviderRequestContext): Promise<Response> {
          return forwardImageGeneration(request, context);
        }
      };
    }
  };
}

async function forwardChatCompletion(request: ChatCompletionRequest, context: ProviderRequestContext): Promise<Response> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const baseUrl = context.credential.base_url || "https://api.openai.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/chat/completions");
  const upstreamRequest = {
    ...request,
    model: context.route.provider_model
  };

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

  if (request.stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Request-Id": context.request_id
      }
    });
  }

  const data = (await upstream.json()) as Record<string, unknown>;
  data.model = request.model;
  return jsonResponse(data, {
    status: 200,
    headers: {
      "X-Request-Id": context.request_id
    }
  });
}

async function mapUpstreamError(response: Response): Promise<Error> {
  let message = `Upstream provider returned ${response.status}`;
  let code = "upstream_error";

  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    if (body.error?.message) {
      message = body.error.message;
    }
    if (body.error?.code) {
      code = String(body.error.code);
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

async function forwardImageGeneration(request: ImageGenerationRequest, context: ProviderRequestContext): Promise<Response> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const hasImageInput = request.image || request.mask;

  if (hasImageInput) {
    return forwardImageEdit(request, context, apiKey);
  }

  const baseUrl = context.credential.base_url || "https://api.openai.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/images/generations");
  const upstreamRequest = buildOpenAIImageRequest(request, context.route.provider_model);

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

  const data = (await upstream.json()) as Record<string, unknown>;
  return jsonResponse(data, {
    status: 200,
    headers: {
      "X-Request-Id": context.request_id
    }
  });
}

async function forwardImageEdit(
  request: ImageGenerationRequest,
  context: ProviderRequestContext,
  apiKey: string
): Promise<Response> {
  const baseUrl = context.credential.base_url || "https://api.openai.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/images/edits");

  const formData = new FormData();
  formData.append("model", context.route.provider_model);
  formData.append("prompt", request.prompt);

  // 处理参考图片
  const imageValue = Array.isArray(request.image) ? request.image[0] : request.image;
  if (imageValue) {
    const imageBlob = await resolveToBlob(imageValue, "image");
    formData.append("image", imageBlob, "image.png");
  }

  // 处理遮罩
  if (request.mask) {
    const maskBlob = await resolveToBlob(request.mask, "mask");
    formData.append("mask", maskBlob, "mask.png");
  }

  if (request.size) formData.append("size", request.size);
  const count = request.image_count || request.n;
  if (count) formData.append("n", String(count));
  if (request.response_format) formData.append("response_format", request.response_format);
  if (typeof request.strength === "number") formData.append("strength", String(request.strength));

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Request-Id": context.request_id
    },
    body: formData,
    signal: context.signal
  });

  if (!upstream.ok) {
    throw await mapUpstreamError(upstream);
  }

  const data = (await upstream.json()) as Record<string, unknown>;
  return jsonResponse(data, {
    status: 200,
    headers: {
      "X-Request-Id": context.request_id
    }
  });
}

/**
 * 将图片输入（URL 或 base64）解析为 Blob。
 */
async function resolveToBlob(input: string, paramName: string): Promise<Blob> {
  if (input.startsWith("data:")) {
    const match = input.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw upstreamError(`Invalid base64 data URI for ${paramName}`, 400, "invalid_request");
    }
    const mimeType = match[1];
    const base64 = match[2];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const response = await fetch(input);
    if (!response.ok) {
      throw upstreamError(`Failed to download ${paramName} from URL: ${response.status}`, 400, "invalid_request");
    }
    return await response.blob();
  }

  throw upstreamError(`${paramName} must be a URL or base64 data URI`, 400, "invalid_request");
}

function buildOpenAIImageRequest(request: ImageGenerationRequest, providerModel: string): Record<string, unknown> {
  const providerParams = objectParam(request.provider_params);
  const upstreamRequest: Record<string, unknown> = {
    ...providerParams,
    ...request,
    model: providerModel
  };
  const imageCount = numberParam(request.image_count, request.n, providerParams.n);
  const width = numberParam(request.width);
  const height = numberParam(request.height);

  if (imageCount !== undefined) {
    upstreamRequest.n = imageCount;
  }
  if (!request.size && width !== undefined && height !== undefined) {
    upstreamRequest.size = `${width}x${height}`;
  }
  delete upstreamRequest.image_count;
  delete upstreamRequest.provider_params;
  if (request.width !== undefined) {
    delete upstreamRequest.width;
  }
  if (request.height !== undefined) {
    delete upstreamRequest.height;
  }

  return upstreamRequest;
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

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
