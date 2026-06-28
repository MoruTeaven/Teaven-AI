import { findModel, loadGatewayConfig, resolveModelAlias, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import type { AuthContext, ChatCompletionRequest, Env, GatewayConfig, ProviderRouteConfig } from "../types";
import { readJsonObject, requireString } from "../utils/request";
import { rewriteModelInJsonResponse, rewriteModelInStreamResponse } from "../utils/model-rewrite";

export async function handleChatCompletions(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const requestedModelName = requireString(body.model, "model");

  if (!Array.isArray(body.messages)) {
    throw invalidRequest("messages must be an array", "messages");
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("stream must be a boolean", "stream");
  }

  // 权限校验：检查用户请求的原始 model 字段（可能是组别名）
  if (auth.allowed_models && !auth.allowed_models.includes(requestedModelName)) {
    throw permissionDenied(`API key cannot access model: ${requestedModelName}`);
  }

  const config = await loadGatewayConfig(env);
  const resolved = resolveModelAlias(config, requestedModelName);
  const streamRequested = body.stream === true;

  // 校验主候选模型
  const model = findModel(config, resolved.resolvedAlias);
  if (!model) {
    throw invalidRequest(`Unknown model: ${requestedModelName}`, "model", "model_not_found");
  }

  if (model.modality !== "text") {
    const hint = model.modality === "image"
      ? ". Use /v1/images/generations for image models."
      : `. Model modality is "${model.modality}", but /v1/chat/completions only accepts text models.`;
    throw invalidRequest(`Model is not a text model: ${requestedModelName}${hint}`, "model");
  }

  if (streamRequested && model.supports_stream === false) {
    throw invalidRequest(`Model does not support stream: ${requestedModelName}`, "stream");
  }

  const route = selectRoute(model, streamRequested);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${requestedModelName}`);
  }

  // 构造调用候选列表：主候选 + 可选 fallback
  const candidates = buildCandidates(resolved.resolvedAlias, resolved.fallbackAlias);

  let response: Response | undefined;
  let usedRoute: ProviderRouteConfig = route;
  let usedAlias = resolved.resolvedAlias;
  let primaryError: unknown;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;

    try {
      const candidateRoute = index === 0
        ? route
        : selectRouteForAlias(config, candidate, streamRequested);
      if (!candidateRoute) {
        if (isLast) break;
        continue;
      }

      const registry = createProviderRegistry(env);
      const plugin = registry.get(candidateRoute.plugin_id);
      const adapter = plugin.createAdapter(env);
      if (!adapter.chatCompletions) {
        if (isLast) {
          throw providerUnavailable(`Provider plugin does not support chat completions: ${candidateRoute.plugin_id}`);
        }
        continue;
      }

      const credential = resolveProviderCredential(env, candidateRoute);
      const requestBody = { ...body, model: candidate };

      const candidateResponse = await adapter.chatCompletions(
        requestBody as ChatCompletionRequest,
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
      break;
    } catch (err) {
      primaryError = primaryError ?? err;
      if (isLast) {
        throw err;
      }
      // 否则继续尝试 fallback
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
    endpoint: "/v1/chat/completions",
    model: usedAlias,
    requested_model: requestedModelName,
    route: usedRoute,
    status_code: response.status,
    latency_ms: Date.now() - startedAt,
    stream: streamRequested,
    usage: streamRequested ? undefined : await readUsage(response.clone())
  });

  // 命中分组时，把响应里的 model 字段重写回组别名
  if (resolved.group) {
    if (streamRequested) {
      return rewriteModelInStreamResponse(response, requestedModelName);
    }
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

/** 为指定 alias 解析可用于 chat completions 的路由 */
function selectRouteForAlias(
  config: GatewayConfig,
  alias: string,
  stream: boolean
): ProviderRouteConfig | undefined {
  const model = findModel(config, alias);
  if (!model || model.modality !== "text") {
    return undefined;
  }
  if (stream && model.supports_stream === false) {
    return undefined;
  }
  return selectRoute(model, stream);
}

async function readUsage(response: Response): Promise<unknown> {
  try {
    const data = (await response.json()) as { usage?: unknown };
    return data.usage;
  } catch {
    return undefined;
  }
}
