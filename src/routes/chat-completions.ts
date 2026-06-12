import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import type { AuthContext, ChatCompletionRequest, Env } from "../types";
import { readJsonObject, requireString } from "../utils/request";

export async function handleChatCompletions(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
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

  const config = loadGatewayConfig(env);
  const model = findModel(config, modelName);
  if (!model) {
    throw invalidRequest(`Unknown model: ${modelName}`, "model", "model_not_found");
  }

  if (model.modality !== "text") {
    throw invalidRequest(`Model is not a text model: ${modelName}`, "model");
  }

  if (body.stream === true && model.supports_stream === false) {
    throw invalidRequest(`Model does not support stream: ${modelName}`, "stream");
  }

  const route = selectRoute(model);
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
  return adapter.chatCompletions(body as ChatCompletionRequest, {
    env,
    request_id: requestId,
    route,
    credential,
    signal: request.signal
  });
}
