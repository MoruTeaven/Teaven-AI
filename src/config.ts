import { invalidRequest } from "./http/errors";
import { clearManagedGatewayConfig, loadManagedGatewayConfig, saveManagedGatewayConfig } from "./admin/store";
import { createId } from "./utils/ids";
import type { Env, GatewayConfig, ModelConfig, ProviderRouteConfig, UpstreamConfig, UpstreamModelConfig } from "./types";

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
    upstreams: [
      {
        id: createId("up"),
        name: "OpenAI Compatible Default",
        plugin_id: "openai-compatible",
        base_url: env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
        credential_id: "env:OPENAI_COMPATIBLE_API_KEY",
        status: "active",
        models: [
          {
            alias: model,
            provider_model: model,
            modality: "text",
            supports_stream: true,
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
  return listModels(config).find((model) => model.alias === alias && model.status !== "disabled");
}

export function listModels(config: GatewayConfig): ModelConfig[] {
  const models = new Map<string, ModelConfig>();

  for (const upstream of config.upstreams) {
    if (upstream.status === "disabled") {
      continue;
    }

    for (const upstreamModel of upstream.models) {
      if (upstreamModel.status === "disabled") {
        continue;
      }

      const existing = models.get(upstreamModel.alias);
      const route = toProviderRoute(upstream, upstreamModel);
      if (existing) {
        existing.routes.push(route);
        existing.supports_stream = existing.supports_stream !== false || upstreamModel.supports_stream !== false;
        if (existing.status === "hidden" && upstreamModel.status !== "hidden") {
          existing.status = upstreamModel.status || "active";
        }
      } else {
        models.set(upstreamModel.alias, {
          alias: upstreamModel.alias,
          modality: upstreamModel.modality,
          supports_stream: upstreamModel.supports_stream !== false,
          status: upstreamModel.status || "active",
          routes: [route]
        });
      }
    }
  }

  return [...models.values()].sort((left, right) => left.alias.localeCompare(right.alias));
}

export function listProviderRoutes(config: GatewayConfig): ProviderRouteConfig[] {
  return listModels(config).flatMap((model) => model.routes);
}

export function selectRoute(model: ModelConfig, stream = false): ProviderRouteConfig | undefined {
  return model.routes
    .filter((route) => route.status !== "disabled" && (!stream || route.supports_stream !== false))
    .sort((left, right) => (left.priority || 100) - (right.priority || 100))[0];
}

export function validateGatewayConfig(config: GatewayConfig): void {
  if (!config || typeof config !== "object" || !Array.isArray(config.upstreams)) {
    throw new Error("upstreams 必须是数组");
  }

  if (config.upstreams.length === 0) {
    throw new Error("至少需要配置一个 upstream");
  }

  const upstreamIds = new Set<string>();
  const aliases = new Map<string, { modality: string; supports_stream: boolean }>();

  for (const upstream of config.upstreams) {
    if (typeof upstream.id !== "string" || upstream.id.length === 0) {
      throw new Error("upstream id 不能为空");
    }
    if (upstreamIds.has(upstream.id)) {
      throw new Error(`upstream id 重复：${upstream.id}`);
    }
    upstreamIds.add(upstream.id);

    if (typeof upstream.plugin_id !== "string" || upstream.plugin_id.length === 0) {
      throw new Error(`upstream ${upstream.id} 必须配置 plugin_id`);
    }
    if (!Array.isArray(upstream.models)) {
      throw new Error(`upstream ${upstream.id} 必须配置 models 数组`);
    }

    for (const model of upstream.models) {
      if (typeof model.alias !== "string" || model.alias.length === 0) {
        throw new Error(`upstream ${upstream.id} 的 model alias 不能为空`);
      }
      if (typeof model.provider_model !== "string" || model.provider_model.length === 0) {
        throw new Error(`model ${model.alias} 必须配置 provider_model`);
      }
      if (!["text", "image", "video", "file"].includes(model.modality)) {
        throw new Error(`model ${model.alias} 的 modality 无效`);
      }

      const existing = aliases.get(model.alias);
      const supportsStream = model.supports_stream !== false;
      if (existing && existing.modality !== model.modality) {
        throw new Error(`model alias ${model.alias} 的 modality 不一致`);
      }
      if (!existing) {
        aliases.set(model.alias, { modality: model.modality, supports_stream: supportsStream });
      }
    }
  }
}

function toProviderRoute(upstream: UpstreamConfig, model: UpstreamModelConfig): ProviderRouteConfig {
  return {
    upstream_id: upstream.id,
    upstream_name: upstream.name,
    plugin_id: upstream.plugin_id,
    provider_model: model.provider_model,
    credential_id: upstream.credential_id,
    base_url: upstream.base_url,
    config: upstream.config,
    modality: model.modality,
    supports_stream: model.supports_stream !== false,
    priority: model.priority,
    weight: model.weight,
    status: model.status || "active"
  };
}
