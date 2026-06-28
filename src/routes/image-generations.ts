import { findModel, findUpstream, loadGatewayConfig, pickAvailableCredential, resolveModelAlias, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import { recordCredentialUsage } from "../admin/credentials-store";
import type { AuthContext, CredentialLimit, Env, GatewayConfig, ImageGenerationRequest, ProviderRouteConfig } from "../types";
import { readJsonObject, requireString, resolveImageInputs, resolveImageInput } from "../utils/request";
import { rewriteModelInJsonResponse } from "../utils/model-rewrite";

export async function handleImageGenerations(
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
  const hasImageInput = body.image || body.mask;
  if (hasImageInput && model.image_mode === "text-to-image") {
    throw invalidRequest(
      `Model does not support image-to-image: ${requestedModelName}`,
      "image",
      "unsupported_image_input"
    );
  }

  const route = selectRoute(model, false);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${requestedModelName}`);
  }

  // 构造调用候选列表：主候选 + 可选 fallback
  const candidates = buildCandidates(resolved.resolvedAlias, resolved.fallbackAlias);

  let response: Response | undefined;
  let usedRoute: ProviderRouteConfig = route;
  let usedAlias = resolved.resolvedAlias;
  let usedCredentialRef: string | undefined;
  let usedCredentialLimits: CredentialLimit[] | undefined;
  let primaryError: unknown;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;

    try {
      const candidateRoute = index === 0
        ? route
        : selectRouteForImageAlias(config, candidate);
      if (!candidateRoute) {
        if (isLast) break;
        continue;
      }

      // 从上游凭证池中按权重+配额挑选一个可用 key
      const upstream = findUpstream(config, candidateRoute.upstream_id);
      const picked = upstream ? await pickAvailableCredential(env, upstream) : undefined;
      if (!picked) {
        if (isLast) {
          throw providerUnavailable(`No available credential for upstream: ${candidateRoute.upstream_id}`);
        }
        continue;
      }

      const registry = createProviderRegistry(env);
      const plugin = registry.get(candidateRoute.plugin_id);
      const adapter = plugin.createAdapter(env);
      if (!adapter.imageGenerations) {
        if (isLast) {
          throw providerUnavailable(`Provider plugin does not support image generation: ${candidateRoute.plugin_id}`);
        }
        continue;
      }

      // 检查 Provider 是否支持图生图
      if (hasImageInput) {
        const imageCap = plugin.manifest.capabilities["image"];
        if (imageCap && imageCap.supports_image_input === false) {
          if (isLast) {
            throw invalidRequest(
              `Provider plugin does not support image-to-image: ${candidateRoute.plugin_id}`,
              "image",
              "unsupported_image_input"
            );
          }
          continue;
        }
      }

      const credential = resolveProviderCredential(env, candidateRoute, picked.credential.credential_id);
      const requestBody = { ...body, model: candidate };

      const candidateResponse = await adapter.imageGenerations(
        requestBody as ImageGenerationRequest,
        {
          env,
          request_id: requestId,
          route: candidateRoute,
          credential,
          signal: request.signal
        }
      );

      // 服务端错误或限流，且有后续候选 → 丢弃当前响应，尝试下一个
      if ((candidateResponse.status >= 500 || candidateResponse.status === 429) && !isLast) {
        try { await candidateResponse.body?.cancel(); } catch { /* ignore */ }
        continue;
      }

      response = candidateResponse;
      usedRoute = candidateRoute;
      usedAlias = candidate;
      usedCredentialRef = picked.ref;
      usedCredentialLimits = picked.credential.limits;
      break;
    } catch (err) {
      primaryError = primaryError ?? err;
      if (isLast) {
        throw err;
      }
    }
  }

  if (!response) {
    if (primaryError) throw primaryError;
    throw providerUnavailable(`No active provider route for model: ${requestedModelName}`);
  }

  await recordChatUsage(env, {
    request_id: requestId,
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    endpoint: "/v1/images/generations",
    model: usedAlias,
    requested_model: requestedModelName,
    route: usedRoute,
    credential_ref: usedCredentialRef,
    status_code: response.status,
    latency_ms: Date.now() - startedAt,
    stream: false,
    usage: undefined
  });

  // 累加凭证配额计数器（图片生成按请求数计，token 为 0）
  if (usedCredentialRef) {
    await recordCredentialUsage(env, usedCredentialRef, usedCredentialLimits, 0).catch(() => { /* 计数器失败不阻断响应 */ });
  }

  // 命中分组时，把响应里的 model 字段重写回组别名
  if (resolved.group) {
    return rewriteModelInJsonResponse(response, requestedModelName);
  }

  return response;
}

/** 构造按优先级排列的候选 alias 列表（主候选 + 可选 fallback） */
function buildCandidates(primaryAlias: string, fallbackAlias?: string): string[] {
  const candidates = [primaryAlias];
  if (fallbackAlias && fallbackAlias !== primaryAlias) {
    candidates.push(fallbackAlias);
  }
  return candidates;
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
