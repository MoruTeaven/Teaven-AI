import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import type { AuthContext, Env, ImageGenerationRequest } from "../types";
import { readJsonObject, requireString } from "../utils/request";

export async function handleImageGenerations(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const modelName = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");

  if (body.n !== undefined && (typeof body.n !== "number" || body.n < 1 || body.n > 10)) {
    throw invalidRequest("n must be an integer between 1 and 10", "n");
  }

  if (body.response_format !== undefined && (typeof body.response_format !== "string" || !["url", "b64_json"].includes(body.response_format))) {
    throw invalidRequest('response_format must be "url" or "b64_json"', "response_format");
  }

  if (auth.allowed_models && !auth.allowed_models.includes(modelName)) {
    throw permissionDenied(`API key cannot access model: ${modelName}`);
  }

  const config = await loadGatewayConfig(env);
  const model = findModel(config, modelName);
  if (!model) {
    throw invalidRequest(`Unknown model: ${modelName}`, "model", "model_not_found");
  }

  if (model.modality !== "image") {
    throw invalidRequest(
      `Model is not an image model: ${modelName}. Use /v1/chat/completions for text models.`,
      "model"
    );
  }

  const route = selectRoute(model, false);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${modelName}`);
  }

  const registry = createProviderRegistry(env);
  const plugin = registry.get(route.plugin_id);
  const adapter = plugin.createAdapter(env);
  if (!adapter.imageGenerations) {
    throw providerUnavailable(`Provider plugin does not support image generation: ${route.plugin_id}`);
  }

  const credential = resolveProviderCredential(env, route);
  const response = await adapter.imageGenerations(body as ImageGenerationRequest, {
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
    endpoint: "/v1/images/generations",
    model: modelName,
    route,
    status_code: response.status,
    latency_ms: Date.now() - startedAt,
    stream: false,
    usage: response.ok ? undefined : undefined
  });

  return response;
}
