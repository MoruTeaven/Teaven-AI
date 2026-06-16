import { providerUnavailable } from "../http/errors";
import type { Env, ProviderRouteConfig } from "../types";
import { createOpenAICompatiblePlugin } from "./openai-compatible";
import type { ProviderCredential, ProviderPlugin } from "./types";

export class ProviderRegistry {
  private readonly plugins = new Map<string, ProviderPlugin>();

  register(plugin: ProviderPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin);
  }

  get(pluginId: string): ProviderPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw providerUnavailable(`Provider plugin not registered: ${pluginId}`);
    }
    return plugin;
  }

  list(): ProviderPlugin[] {
    return [...this.plugins.values()];
  }
}

export function createProviderRegistry(env: Env): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(createOpenAICompatiblePlugin(env));
  return registry;
}

export function resolveProviderCredential(env: Env, route: ProviderRouteConfig): ProviderCredential {
  const credentialId = route.credential_id;
  if (!credentialId) {
    throw providerUnavailable(`Provider credential is not configured for upstream: ${route.upstream_id}`);
  }

  let apiKey: string | undefined;

  if (credentialId.startsWith("env:")) {
    // env: 前缀 → 从环境变量 / Secret 中读取
    const secretName = credentialId.slice(4);
    apiKey = getEnvString(env, secretName);
    if (!apiKey) {
      throw providerUnavailable(`Provider credential is not configured, env secret missing: ${secretName}`);
    }
  } else {
    // 无 env: 前缀 → 直接作为 API Key 使用
    apiKey = credentialId;
  }

  return {
    id: credentialId,
    plugin_id: route.plugin_id,
    api_key: apiKey,
    base_url: route.base_url,
    config: route.config
  };
}

function getEnvString(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
