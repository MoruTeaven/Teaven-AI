import { invalidRequest } from "./http/errors";
import type { Env, GatewayConfig, ModelConfig, ProviderRouteConfig } from "./types";

export function loadGatewayConfig(env: Env): GatewayConfig {
  if (env.MODEL_CONFIG_JSON) {
    try {
      const config = JSON.parse(env.MODEL_CONFIG_JSON) as GatewayConfig;
      validateGatewayConfig(config);
      return config;
    } catch (error) {
      if (error instanceof Error) {
        throw invalidRequest(`Invalid MODEL_CONFIG_JSON: ${error.message}`);
      }
      throw invalidRequest("Invalid MODEL_CONFIG_JSON");
    }
  }

  const model = env.OPENAI_COMPATIBLE_DEFAULT_MODEL || "gpt-4o-mini";
  return {
    models: [
      {
        alias: model,
        modality: "text",
        supports_stream: true,
        status: "active",
        routes: [
          {
            plugin_id: "openai-compatible",
            provider: "openai-compatible",
            provider_model: model,
            credential_id: "env:OPENAI_COMPATIBLE_API_KEY",
            priority: 1,
            weight: 100,
            status: "active"
          }
        ]
      }
    ]
  };
}

export function findModel(config: GatewayConfig, alias: string): ModelConfig | undefined {
  return config.models.find((model) => model.alias === alias && model.status !== "disabled");
}

export function selectRoute(model: ModelConfig): ProviderRouteConfig | undefined {
  return model.routes
    .filter((route) => route.status !== "disabled")
    .sort((left, right) => (left.priority || 100) - (right.priority || 100))[0];
}

function validateGatewayConfig(config: GatewayConfig): void {
  if (!config || typeof config !== "object" || !Array.isArray(config.models)) {
    throw new Error("models must be an array");
  }

  for (const model of config.models) {
    if (typeof model.alias !== "string" || model.alias.length === 0) {
      throw new Error("model alias is required");
    }
    if (!Array.isArray(model.routes) || model.routes.length === 0) {
      throw new Error(`model ${model.alias} must have routes`);
    }
  }
}
