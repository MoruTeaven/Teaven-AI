import { invalidRequest } from "./http/errors";
import { clearManagedGatewayConfig, loadManagedGatewayConfig, saveManagedGatewayConfig } from "./admin/store";
import type { Env, GatewayConfig, ModelConfig, ProviderRouteConfig } from "./types";

export async function loadGatewayConfig(env: Env): Promise<GatewayConfig> {
  const managedConfig = await loadManagedGatewayConfig(env);
  if (managedConfig) {
    validateGatewayConfig(managedConfig);
    return managedConfig;
  }

  if (env.MODEL_CONFIG_JSON) {
    try {
      const config = JSON.parse(env.MODEL_CONFIG_JSON) as GatewayConfig;
      validateGatewayConfig(config);
      return config;
    } catch (error) {
      if (error instanceof Error) {
        throw invalidRequest(`MODEL_CONFIG_JSON 无效：${error.message}`);
      }
      throw invalidRequest("MODEL_CONFIG_JSON 无效");
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

export async function saveGatewayConfig(env: Env, config: GatewayConfig): Promise<void> {
  validateGatewayConfig(config);
  await saveManagedGatewayConfig(env, config);
}

export async function resetGatewayConfig(env: Env): Promise<void> {
  await clearManagedGatewayConfig(env);
}

export function findModel(config: GatewayConfig, alias: string): ModelConfig | undefined {
  return config.models.find((model) => model.alias === alias && model.status !== "disabled");
}

export function selectRoute(model: ModelConfig): ProviderRouteConfig | undefined {
  return model.routes
    .filter((route) => route.status !== "disabled")
    .sort((left, right) => (left.priority || 100) - (right.priority || 100))[0];
}

export function validateGatewayConfig(config: GatewayConfig): void {
  if (!config || typeof config !== "object" || !Array.isArray(config.models)) {
    throw new Error("models 必须是数组");
  }

  for (const model of config.models) {
    if (typeof model.alias !== "string" || model.alias.length === 0) {
      throw new Error("model alias 不能为空");
    }
    if (!Array.isArray(model.routes) || model.routes.length === 0) {
      throw new Error(`model ${model.alias} 必须配置 routes`);
    }
  }
}
