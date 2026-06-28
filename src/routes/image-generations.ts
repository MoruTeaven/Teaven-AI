import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import type { AuthContext, Env, ImageGenerationRequest } from "../types";
import { readJsonObject, requireString, resolveImageInputs, resolveImageInput } from "../utils/request";

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

  // 检查模型是否支持图生图
  const hasImageInput = body.image || body.mask;
  if (hasImageInput && model.image_mode === "text-to-image") {
    throw invalidRequest(
      `Model does not support image-to-image: ${modelName}`,
      "image",
      "unsupported_image_input"
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

  // 检查 Provider 是否支持图生图
  if (hasImageInput) {
    const imageCap = plugin.manifest.capabilities["image"];
    if (imageCap && imageCap.supports_image_input === false) {
      throw invalidRequest(
        `Provider plugin does not support image-to-image: ${route.plugin_id}`,
        "image",
        "unsupported_image_input"
      );
    }
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
