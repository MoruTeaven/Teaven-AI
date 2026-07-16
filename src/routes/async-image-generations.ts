import { findModel, findUpstream, loadGatewayConfig, pickAvailableCredential, resolveModelAlias, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import { recordCredentialUsage } from "../admin/credentials-store";
import { appendTaskEvent, taskDiagnostics } from "../tasks/events";
import { getTaskByIdempotencyKey, saveTask } from "../tasks/store";
import type { AuthContext, AsyncTaskRecord, CredentialLimit, Env, GatewayConfig, ImageGenerationRequest, ProviderRouteConfig } from "../types";
import { createId } from "../utils/ids";
import { optionalHttpsUrl, readJsonObject, requireString, resolveImageInputs, resolveImageInput } from "../utils/request";
import { rewriteModelInJsonResponse } from "../utils/model-rewrite";
import { resolveImageSize } from "../utils/image-size";

interface UpstreamCallResult {
  response: Response;
  route: ProviderRouteConfig;
  usedAlias: string;
  /** 实际选中凭证的 secret 引用（env:... 或直接 key），用于回填 provider_context */
  credentialId: string | undefined;
  credentialRef: string | undefined;
  credentialLimits: CredentialLimit[] | undefined;
}

interface UpstreamSelectionResult {
  route: ProviderRouteConfig;
  usedAlias: string;
  credentialId: string | undefined;
  credentialRef: string | undefined;
  credentialLimits: CredentialLimit[] | undefined;
}

const DEFAULT_STORAGE_TTL_SECONDS = 24 * 60 * 60;

export async function handleAsyncImageGenerations(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const requestedModelName = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");

  if (body.n !== undefined && (typeof body.n !== "number" || body.n < 1 || body.n > 10)) {
    throw invalidRequest("n must be an integer between 1 and 10", "n");
  }

  if (body.response_format !== undefined && (typeof body.response_format !== "string" || !["url", "b64_json"].includes(body.response_format))) {
    throw invalidRequest('response_format must be "url" or "b64_json"', "response_format");
  }

  if (body.store_output !== undefined && typeof body.store_output !== "boolean") {
    throw invalidRequest("store_output must be a boolean", "store_output");
  }

  const storeOutput = body.store_output === true;
  const storageTtlSeconds = normalizeStorageTtl(body.storage_ttl_seconds);
  const callbackUrl = optionalHttpsUrl(body.callback_url, "callback_url");

  // 校验图片输入
  if (body.image !== undefined) {
    resolveImageInputs(body.image);
  }
  if (body.mask !== undefined) {
    resolveImageInput(body.mask);
  }
  if (body.strength !== undefined) {
    if (typeof body.strength !== "number" || body.strength < 0 || body.strength > 1) {
      throw invalidRequest("strength must be a number between 0 and 1", "strength");
    }
  }

  // 权限校验：检查用户请求的原始 model 字段（可能是组别名）
  if (auth.allowed_models && !auth.allowed_models.includes(requestedModelName)) {
    throw permissionDenied(`API key cannot access model: ${requestedModelName}`);
  }

  const config = await loadGatewayConfig(env);
  const resolved = resolveModelAlias(config, requestedModelName);

  // 校验主候选模型
  const model = findModel(config, resolved.resolvedAlias);
  if (!model) {
    throw invalidRequest(`Unknown model: ${requestedModelName}`, "model", "model_not_found");
  }

  if (model.modality !== "image") {
    throw invalidRequest(
      `Model is not an image model: ${requestedModelName}. Use /v1/chat/completions for text models.`,
      "model"
    );
  }

  // 检查模型是否支持图生图
  const hasImageInput = Boolean(body.image || body.mask);
  if (hasImageInput && model.image_mode === "text-to-image") {
    throw invalidRequest(
      `Model does not support image-to-image: ${requestedModelName}`,
      "image",
      "unsupported_image_input"
    );
  }

  // 解析 aspect_ratio 和 quality，自动匹配 width/height
  if (body.aspect_ratio !== undefined || body.quality !== undefined) {
    if (body.width === undefined && body.height === undefined) {
      const resolvedSize = resolveImageSize(
        body.aspect_ratio as string | undefined,
        body.quality as string | undefined,
        model.supported_image_sizes
      );
      if (resolvedSize) {
        body.width = resolvedSize.width;
        body.height = resolvedSize.height;
      } else if (model.supported_image_sizes && model.supported_image_sizes.length > 0) {
        throw invalidRequest(
          `Unsupported aspect_ratio or quality for model: ${requestedModelName}. Supported sizes: ${model.supported_image_sizes.map(s => `${s.name}${s.quality ? `(${s.quality})` : ''}`).join(', ')}`,
          "aspect_ratio"
        );
      }
    } else {
      throw invalidRequest(
        "Cannot specify both width/height and aspect_ratio/quality",
        "aspect_ratio"
      );
    }
  }

  const route = selectRoute(model, false);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${requestedModelName}`);
  }

  const providerBody = providerRequestBody(body);
  const idempotencyKey = request.headers.get("Idempotency-Key") || undefined;

  if (idempotencyKey) {
    const existing = await getTaskByIdempotencyKey(env, auth.organization_id, idempotencyKey);
    if (existing) {
      return asyncTaskResponse(existing, requestedModelName, requestId, true);
    }
  }

  const selection = await selectUpstreamWithFallback({
    env,
    requestId,
    config,
    primaryAlias: resolved.resolvedAlias,
    primaryRoute: route,
    fallbackAlias: resolved.fallbackAlias,
    body: providerBody,
    hasImageInput
  });

  const usedRoute = selection.route;
  const usedAlias = selection.usedAlias;
  const usedCredentialRef = selection.credentialRef;
  const now = new Date().toISOString();
  const task: AsyncTaskRecord = {
    id: createId("task"),
    object: "task",
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    type: "image",
    model: usedAlias,
    requested_model: resolved.group ? requestedModelName : undefined,
    upstream_id: usedRoute.upstream_id,
    plugin_id: usedRoute.plugin_id,
    credential_ref: usedCredentialRef,
    provider_context: {
      upstream_model: usedRoute.provider_model,
      request_id: requestId,
      base_url: usedRoute.base_url,
      credential_id: selection.credentialId || usedRoute.credential_id,
      credential_ref: usedCredentialRef,
      credential_limits: selection.credentialLimits,
      config: usedRoute.config
    },
    status: "queued",
    input: { ...providerBody, model: usedAlias },
    store_output: storeOutput,
    storage_ttl_seconds: storageTtlSeconds,
    output_expires_at: null,
    callback_url: callbackUrl,
    metadata: body.metadata as Record<string, unknown> | undefined,
    idempotency_key: idempotencyKey,
    created_at: now,
    updated_at: now
  };

  appendTaskEvent(task, {
    stage: "task.created",
    status: task.status,
    request_id: requestId,
    credential_ref: usedCredentialRef || null,
    message: "Task created via /v1/async/images/generations"
  });

  try {
    await saveTask(env, task);
  } catch (err) {
    const existing = idempotencyKey ? await getTaskByIdempotencyKey(env, auth.organization_id, idempotencyKey) : undefined;
    if (existing) {
      return asyncTaskResponse(existing, requestedModelName, requestId, true);
    }
    throw err;
  }

  await enqueueCreatedTask(env, task);

  await recordChatUsage(env, {
    request_id: requestId,
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    endpoint: "/v1/async/images/generations",
    model: usedAlias,
    requested_model: requestedModelName,
    route: usedRoute,
    credential_ref: usedCredentialRef,
    status_code: 202,
    latency_ms: Date.now() - startedAt,
    stream: false,
    usage: undefined
  });

  return asyncTaskResponse(task, resolved.group ? requestedModelName : usedAlias, requestId, false);
}

async function selectUpstreamWithFallback(params: {
  env: Env;
  requestId: string;
  config: GatewayConfig;
  primaryAlias: string;
  primaryRoute: ProviderRouteConfig;
  fallbackAlias?: string;
  body: Record<string, unknown>;
  hasImageInput: boolean;
}): Promise<UpstreamSelectionResult> {
  const candidates: Array<{ alias: string; route: ProviderRouteConfig }> = [
    { alias: params.primaryAlias, route: params.primaryRoute }
  ];
  if (params.fallbackAlias && params.fallbackAlias !== params.primaryAlias) {
    const fallbackRoute = selectRouteForImageAlias(params.config, params.fallbackAlias);
    if (fallbackRoute) {
      candidates.push({ alias: params.fallbackAlias, route: fallbackRoute });
    }
  }

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;
    const registry = createProviderRegistry(params.env);
    const plugin = registry.get(candidate.route.plugin_id);
    const adapter = plugin.createAdapter(params.env);

    if (!adapter.imageGenerations) {
      if (isLast) {
        throw providerUnavailable(`Provider plugin does not support image generation: ${candidate.route.plugin_id}`);
      }
      continue;
    }

    if (params.hasImageInput) {
      const imageCap = plugin.manifest.capabilities["image"];
      if (imageCap && imageCap.supports_image_input === false) {
        if (isLast) {
          throw invalidRequest(
            `Provider plugin does not support image-to-image: ${candidate.route.plugin_id}`,
            "image",
            "unsupported_image_input"
          );
        }
        continue;
      }
    }

    const upstream = findUpstream(params.config, candidate.route.upstream_id);
    const picked = upstream ? await pickAvailableCredential(params.env, upstream) : undefined;
    if (!picked) {
      if (isLast) {
        throw providerUnavailable(`No available credential for upstream: ${candidate.route.upstream_id}`);
      }
      continue;
    }

    return {
      route: candidate.route,
      usedAlias: candidate.alias,
      credentialId: picked.credential.credential_id,
      credentialRef: picked.ref,
      credentialLimits: picked.credential.limits
    };
  }

  throw providerUnavailable("No upstream candidate succeeded");
}

function asyncTaskResponse(
  task: AsyncTaskRecord,
  requestedModelName: string,
  requestId: string,
  idempotentReplay: boolean
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId
  };
  if (idempotentReplay) {
    headers["Idempotent-Replayed"] = "true";
  }

  return new Response(
    JSON.stringify({
      id: task.id,
      object: "task",
      type: task.type,
      model: task.requested_model || requestedModelName || task.model,
      status: task.status,
      provider_task_id: task.provider_task_id || null,
      diagnostics: taskDiagnostics(task),
      events: task.events || [],
      created_at: task.created_at,
      updated_at: task.updated_at
    }),
    {
      status: isTerminalTask(task) ? 200 : 202,
      headers
    }
  );
}

function isTerminalTask(task: AsyncTaskRecord): boolean {
  return ["succeeded", "failed", "canceled", "expired"].includes(task.status);
}

/** 调用上游接口，主候选失败（5xx/429/网络错误）时按 fallback 重试 */
async function callUpstreamWithFallback(params: {
  env: Env;
  request: Request;
  requestId: string;
  config: GatewayConfig;
  primaryAlias: string;
  primaryRoute: ProviderRouteConfig;
  fallbackAlias?: string;
  body: Record<string, unknown>;
  hasImageInput: boolean;
}): Promise<UpstreamCallResult> {
  const candidates: Array<{ alias: string; route: ProviderRouteConfig }> = [
    { alias: params.primaryAlias, route: params.primaryRoute }
  ];
  if (params.fallbackAlias && params.fallbackAlias !== params.primaryAlias) {
    const fallbackRoute = selectRouteForImageAlias(params.config, params.fallbackAlias);
    if (fallbackRoute) {
      candidates.push({ alias: params.fallbackAlias, route: fallbackRoute });
    }
  }

  let primaryError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;

    try {
      const registry = createProviderRegistry(params.env);
      const plugin = registry.get(candidate.route.plugin_id);
      const adapter = plugin.createAdapter(params.env);

      if (!adapter.imageGenerations) {
        if (isLast) {
          throw providerUnavailable(`Provider plugin does not support image generation: ${candidate.route.plugin_id}`);
        }
        continue;
      }

      // 检查 Provider 是否支持图生图
      if (params.hasImageInput) {
        const imageCap = plugin.manifest.capabilities["image"];
        if (imageCap && imageCap.supports_image_input === false) {
          if (isLast) {
            throw invalidRequest(
              `Provider plugin does not support image-to-image: ${candidate.route.plugin_id}`,
              "image",
              "unsupported_image_input"
            );
          }
          continue;
        }
      }

      // 从上游凭证池中按权重+配额挑选一个可用 key
      const upstream = findUpstream(params.config, candidate.route.upstream_id);
      const picked = upstream ? await pickAvailableCredential(params.env, upstream) : undefined;
      if (!picked) {
        if (isLast) {
          throw providerUnavailable(`No available credential for upstream: ${candidate.route.upstream_id}`);
        }
        continue;
      }

      const credential = resolveProviderCredential(params.env, candidate.route, picked.credential.credential_id);
      const requestBody = { ...params.body, model: candidate.alias };

      const response = await adapter.imageGenerations(
        requestBody as ImageGenerationRequest,
        {
          env: params.env,
          request_id: params.requestId,
          route: candidate.route,
          credential,
          signal: params.request.signal
        }
      );

      // 服务端错误或限流，且有后续候选 → 丢弃当前响应，尝试下一个
      if ((response.status >= 500 || response.status === 429) && !isLast) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        continue;
      }

      return {
        response,
        route: candidate.route,
        usedAlias: candidate.alias,
        credentialId: picked.credential.credential_id,
        credentialRef: picked.ref,
        credentialLimits: picked.credential.limits
      };
    } catch (err) {
      primaryError = primaryError ?? err;
      if (isLast) {
        throw err;
      }
    }
  }

  if (primaryError) throw primaryError;
  throw providerUnavailable("No upstream candidate succeeded");
}

/** 为指定 alias 解析可用于图片生成的路由 */
function selectRouteForImageAlias(
  config: GatewayConfig,
  alias: string
): ProviderRouteConfig | undefined {
  const model = findModel(config, alias);
  if (!model || model.modality !== "image") {
    return undefined;
  }
  return selectRoute(model, false);
}

function providerRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const providerBody = { ...body };
  delete providerBody.callback_url;
  delete providerBody.metadata;
  delete providerBody.store_output;
  delete providerBody.storage_ttl_seconds;
  return providerBody;
}

function normalizeStorageTtl(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_STORAGE_TTL_SECONDS;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidRequest("storage_ttl_seconds must be an integer", "storage_ttl_seconds");
  }

  if (value < 1 || value > DEFAULT_STORAGE_TTL_SECONDS) {
    throw invalidRequest("storage_ttl_seconds must be between 1 and 86400", "storage_ttl_seconds");
  }

  return value;
}

async function enqueueCreatedTask(env: Env, task: AsyncTaskRecord): Promise<void> {
  if (!env.TASK_QUEUE) {
    appendTaskEvent(task, {
      stage: "queue.unavailable",
      status: task.status,
      message: "TASK_QUEUE binding is not configured"
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
    throw providerUnavailable("TASK_QUEUE binding is not configured");
  }

  try {
    await env.TASK_QUEUE.send({ task_id: task.id });
    appendTaskEvent(task, {
      stage: "queue.enqueued",
      status: task.status,
      message: "Task submitted to TASK_QUEUE"
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
  } catch (err) {
    appendTaskEvent(task, {
      stage: "queue.enqueue_failed",
      status: task.status,
      error: errorMessage(err)
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
    throw err;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
