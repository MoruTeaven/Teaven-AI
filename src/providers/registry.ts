import { providerUnavailable } from "../http/errors";
import type { Env, ProviderRouteConfig } from "../types";
import { createCloudflareWorkersAIPlugin } from "./cloudflare-workers-ai";
import { createOpenAICompatiblePlugin } from "./openai-compatible";
import { createMoarkAsyncPlugin } from "./moark-async";
import type { ProviderCredential, ProviderPlugin } from "./types";

const BLOCKED_PROVIDER_SECRET_NAMES = new Set([
  "ADMIN_TOKEN",
  "USER_CENTER_TOKEN",
  "DEV_API_KEY",
  "MODEL_CONFIG_JSON",
  "AUTH_MODE",
  "API_ORIGIN",
  "FILES_PUBLIC_BASE_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_DEFAULT_MODEL"
]);

const DEFAULT_PROVIDER_SECRET_PATTERN = /^[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|BEARER_TOKEN|TOKEN)$/;

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
  registry.register(createCloudflareWorkersAIPlugin(env));
  registry.register(createMoarkAsyncPlugin(env));
  return registry;
}

export function resolveProviderCredential(
  env: Env,
  route: ProviderRouteConfig,
  credentialIdOverride?: string
): ProviderCredential {
  // 多凭证场景下，调用方传入实际选中的 credential_id（来自 UpstreamCredential.credential_id）。
  // 未传时回退到 route.credential_id（legacy 单凭证）。
  const credentialId = credentialIdOverride || route.credential_id;
  if (!credentialId) {
    throw providerUnavailable(`Provider credential is not configured for upstream: ${route.upstream_id}`);
  }

  let apiKey: string | undefined;

  if (credentialId.startsWith("env:")) {
    // env: 前缀 → 从环境变量 / Secret 中读取
    const secretName = credentialId.slice(4);
    if (!isAllowedProviderSecretName(env, secretName)) {
      throw providerUnavailable(`Provider credential env secret is not allowed: ${secretName}`);
    }
    apiKey = getEnvString(env, secretName);
    if (!apiKey) {
      throw providerUnavailable(`Provider credential is not configured, env secret missing: ${secretName}`);
    }
  } else {
    if (env.ALLOW_INLINE_PROVIDER_CREDENTIALS !== "true") {
      throw providerUnavailable("Inline provider credentials are disabled; use env:SECRET_NAME instead");
    }
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

export function isAllowedProviderSecretName(env: Env | undefined, secretName: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(secretName) || BLOCKED_PROVIDER_SECRET_NAMES.has(secretName)) {
    return false;
  }

  const allowlist = parseProviderSecretAllowlist(env?.PROVIDER_SECRET_ALLOWLIST);
  if (allowlist) {
    return allowlist.has(secretName);
  }

  return DEFAULT_PROVIDER_SECRET_PATTERN.test(secretName);
}

function parseProviderSecretAllowlist(value: string | undefined): Set<string> | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}
