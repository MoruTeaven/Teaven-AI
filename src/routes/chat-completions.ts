import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import type { AuthContext, ChatCompletionRequest, Env } from "../types";
import { readJsonObject, requireString } from "../utils/request";

export async function handleChatCompletions(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const modelName = requireString(body.model, "model");

  if (!Array.isArray(body.messages)) {
    throw invalidRequest("messages must be an array", "messages");
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalidRequest("stream must be a boolean", "stream");
  }

  if (auth.allowed_models && !auth.allowed_models.includes(modelName)) {
    throw permissionDenied(`API key cannot access model: ${modelName}`);
  }

  const config = await loadGatewayConfig(env);
  const model = findModel(config, modelName);
  if (!model) {
    throw invalidRequest(`Unknown model: ${modelName}`, "model", "model_not_found");
  }

  if (model.modality !== "text") {
    const hint = model.modality === "image"
      ? ". Use /v1/images/generations for image models."
      : `. Model modality is "${model.modality}", but /v1/chat/completions only accepts text models.`;
    throw invalidRequest(`Model is not a text model: ${modelName}${hint}`, "model");
  }

  if (body.stream === true && model.supports_stream === false) {
    throw invalidRequest(`Model does not support stream: ${modelName}`, "stream");
  }

  const route = selectRoute(model, body.stream === true);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${modelName}`);
  }

  const registry = createProviderRegistry(env);
  const plugin = registry.get(route.plugin_id);
  const adapter = plugin.createAdapter(env);
  if (!adapter.chatCompletions) {
    throw providerUnavailable(`Provider plugin does not support chat completions: ${route.plugin_id}`);
  }

  const credential = resolveProviderCredential(env, route);
  const response = await adapter.chatCompletions(body as ChatCompletionRequest, {
    env,
    request_id: requestId,
    route,
    credential,
    signal: request.signal
  });

  await recordChatUsage(env, {
    request_id: requestId,
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    endpoint: "/v1/chat/completions",
    model: modelName,
    route,
    status_code: response.status,
    latency_ms: Date.now() - startedAt,
    stream: body.stream === true,
    usage: body.stream === true ? undefined : await readUsage(response.clone())
  });

  return response;
}

async function readUsage(response: Response): Promise<unknown> {
  try {
    const data = (await response.json()) as { usage?: unknown };
    return data.usage;
  } catch {
    return undefined;
  }
}
