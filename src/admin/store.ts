import type { AsyncTaskRecord, Env, GatewayConfig, ProviderRouteConfig } from "../types";
import { createId } from "../utils/ids";

const GATEWAY_CONFIG_KEY = "admin:gateway_config";
const USER_PREFIX = "admin:user:";
const API_KEY_PREFIX = "admin:api_key:";
const API_KEY_HASH_PREFIX = "admin:api_key_hash:";
const USAGE_PREFIX = "admin:usage:";
const MAX_LIST_LIMIT = 200;

const MEMORY = {
  gatewayConfig: undefined as GatewayConfig | undefined,
  users: new Map<string, AdminUser>(),
  apiKeys: new Map<string, AdminApiKey>(),
  apiKeyHashes: new Map<string, string>(),
  usage: new Map<string, UsageRecord>()
};

export interface AdminUser {
  id: string;
  tenant_id: string;
  email: string;
  name?: string;
  role: "owner" | "admin" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface AdminApiKey {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_models?: string[];
  status: "active" | "disabled" | "expired";
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

export interface CreatedAdminApiKey {
  apiKey: AdminApiKey;
  token: string;
}

export interface UsageRecord {
  id: string;
  request_id: string;
  tenant_id: string;
  api_key_id: string;
  endpoint: string;
  model: string;
  upstream_id?: string;
  plugin_id?: string;
  provider_model?: string;
  status_code: number;
  latency_ms: number;
  stream: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  media_count: number;
  cost: number;
  created_at: string;
}

export interface UsageSummary {
  total_requests: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  media_count: number;
  cost: number;
  by_model: Array<{
    model: string;
    requests: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    media_count: number;
    cost: number;
  }>;
  recent: UsageRecord[];
}

export async function loadManagedGatewayConfig(env: Env): Promise<GatewayConfig | undefined> {
  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(GATEWAY_CONFIG_KEY, "json");
    if (stored && typeof stored === "object") {
      return stored as GatewayConfig;
    }
  }

  return MEMORY.gatewayConfig;
}

export async function saveManagedGatewayConfig(env: Env, config: GatewayConfig): Promise<void> {
  MEMORY.gatewayConfig = config;

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(GATEWAY_CONFIG_KEY, JSON.stringify(config));
  }
}

export async function clearManagedGatewayConfig(env: Env): Promise<void> {
  MEMORY.gatewayConfig = undefined;

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.delete(GATEWAY_CONFIG_KEY);
  }
}

export async function listAdminUsers(env: Env): Promise<AdminUser[]> {
  return listStoredObjects<AdminUser>(env, USER_PREFIX, MEMORY.users, isAdminUser);
}

export async function getAdminUser(env: Env, userId: string): Promise<AdminUser | undefined> {
  return getStoredObject<AdminUser>(env, `${USER_PREFIX}${userId}`, MEMORY.users, userId, isAdminUser);
}

export async function findAdminUserByEmail(env: Env, email: string): Promise<AdminUser | undefined> {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await listAdminUsers(env);
  return users.find((user) => user.email.toLowerCase() === normalizedEmail);
}

export async function createAdminUser(
  env: Env,
  input: Pick<AdminUser, "email"> & Partial<Pick<AdminUser, "name" | "role" | "status" | "tenant_id">>
): Promise<AdminUser> {
  const now = new Date().toISOString();
  const user: AdminUser = {
    id: createId("user"),
    tenant_id: input.tenant_id || createId("tenant"),
    email: input.email,
    name: input.name,
    role: input.role || "member",
    status: input.status || "active",
    created_at: now,
    updated_at: now
  };

  await saveAdminUser(env, user);
  return user;
}

export async function saveAdminUser(env: Env, user: AdminUser): Promise<void> {
  MEMORY.users.set(user.id, user);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(`${USER_PREFIX}${user.id}`, JSON.stringify(user));
  }
}

export async function listAdminApiKeys(env: Env): Promise<AdminApiKey[]> {
  return listStoredObjects<AdminApiKey>(env, API_KEY_PREFIX, MEMORY.apiKeys, isAdminApiKey);
}

export async function getAdminApiKey(env: Env, apiKeyId: string): Promise<AdminApiKey | undefined> {
  return getStoredObject<AdminApiKey>(env, `${API_KEY_PREFIX}${apiKeyId}`, MEMORY.apiKeys, apiKeyId, isAdminApiKey);
}

export async function createAdminApiKey(
  env: Env,
  input: Pick<AdminApiKey, "tenant_id" | "user_id" | "name"> & Partial<Pick<AdminApiKey, "allowed_models" | "expires_at">>
): Promise<CreatedAdminApiKey> {
  const now = new Date().toISOString();
  const token = createApiToken();
  const apiKey: AdminApiKey = {
    id: createId("key"),
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    name: input.name,
    key_hash: await sha256Base64Url(token),
    key_prefix: token.slice(0, 14),
    allowed_models: input.allowed_models,
    status: "active",
    expires_at: input.expires_at || null,
    created_at: now,
    updated_at: now,
    last_used_at: null
  };

  await saveAdminApiKey(env, apiKey);
  return { apiKey, token };
}

export async function findAdminApiKeyByToken(env: Env, token: string): Promise<AdminApiKey | undefined> {
  const hash = await sha256Base64Url(token);
  let apiKeyId: string | undefined;

  if (env.AI_GATEWAY_KV) {
    apiKeyId = (await env.AI_GATEWAY_KV.get(`${API_KEY_HASH_PREFIX}${hash}`)) || undefined;
  } else {
    apiKeyId = MEMORY.apiKeyHashes.get(hash);
  }

  if (!apiKeyId) {
    return undefined;
  }

  const apiKey = await getAdminApiKey(env, apiKeyId);
  if (!apiKey || apiKey.key_hash !== hash) {
    return undefined;
  }

  return apiKey;
}

export async function saveAdminApiKey(env: Env, apiKey: AdminApiKey): Promise<void> {
  MEMORY.apiKeys.set(apiKey.id, apiKey);
  MEMORY.apiKeyHashes.set(apiKey.key_hash, apiKey.id);

  if (env.AI_GATEWAY_KV) {
    await Promise.all([
      env.AI_GATEWAY_KV.put(`${API_KEY_PREFIX}${apiKey.id}`, JSON.stringify(apiKey)),
      env.AI_GATEWAY_KV.put(`${API_KEY_HASH_PREFIX}${apiKey.key_hash}`, apiKey.id)
    ]);
  }
}

export async function touchAdminApiKey(env: Env, apiKey: AdminApiKey): Promise<void> {
  apiKey.last_used_at = new Date().toISOString();
  apiKey.updated_at = apiKey.last_used_at;
  await saveAdminApiKey(env, apiKey);
}

export async function recordChatUsage(
  env: Env,
  input: {
    request_id: string;
    tenant_id: string;
    api_key_id: string;
    endpoint: string;
    model: string;
    route?: ProviderRouteConfig;
    status_code: number;
    latency_ms: number;
    stream: boolean;
    usage?: unknown;
  }
): Promise<void> {
  const usage = normalizeUsage(input.usage);
  const record: UsageRecord = {
    id: createId("usage"),
    request_id: input.request_id,
    tenant_id: input.tenant_id,
    api_key_id: input.api_key_id,
    endpoint: input.endpoint,
    model: input.model,
    upstream_id: input.route?.upstream_id,
    plugin_id: input.route?.plugin_id,
    provider_model: input.route?.provider_model,
    status_code: input.status_code,
    latency_ms: input.latency_ms,
    stream: input.stream,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    media_count: 0,
    cost: 0,
    created_at: new Date().toISOString()
  };

  await saveUsageRecord(env, record);
}

export async function recordTaskUsage(env: Env, task: AsyncTaskRecord, statusCode: number, latencyMs: number): Promise<void> {
  await saveUsageRecord(env, {
    id: createId("usage"),
    request_id: task.id,
    tenant_id: task.tenant_id,
    api_key_id: task.api_key_id,
    endpoint: "/v1/tasks",
    model: task.model,
    upstream_id: task.upstream_id,
    plugin_id: task.plugin_id,
    provider_model: task.provider_task_id,
    status_code: statusCode,
    latency_ms: latencyMs,
    stream: false,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    media_count: 1,
    cost: 0,
    created_at: new Date().toISOString()
  });
}

export async function listUsageRecords(env: Env): Promise<UsageRecord[]> {
  return listStoredObjects<UsageRecord>(env, USAGE_PREFIX, MEMORY.usage, isUsageRecord);
}

export async function summarizeUsage(env: Env): Promise<UsageSummary> {
  const records = (await listUsageRecords(env)).sort((left, right) => right.created_at.localeCompare(left.created_at));
  const byModel = new Map<string, UsageSummary["by_model"][number]>();
  const summary: UsageSummary = {
    total_requests: records.length,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    media_count: 0,
    cost: 0,
    by_model: [],
    recent: records.slice(0, 50)
  };

  for (const record of records) {
    summary.total_tokens += record.total_tokens;
    summary.prompt_tokens += record.prompt_tokens;
    summary.completion_tokens += record.completion_tokens;
    summary.media_count += record.media_count;
    summary.cost += record.cost;

    const model = byModel.get(record.model) || {
      model: record.model,
      requests: 0,
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      media_count: 0,
      cost: 0
    };
    model.requests += 1;
    model.total_tokens += record.total_tokens;
    model.prompt_tokens += record.prompt_tokens;
    model.completion_tokens += record.completion_tokens;
    model.media_count += record.media_count;
    model.cost += record.cost;
    byModel.set(record.model, model);
  }

  summary.by_model = [...byModel.values()].sort((left, right) => right.requests - left.requests);
  return summary;
}

async function saveUsageRecord(env: Env, record: UsageRecord): Promise<void> {
  MEMORY.usage.set(record.id, record);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(`${USAGE_PREFIX}${record.id}`, JSON.stringify(record));
  }
}

async function listStoredObjects<T>(
  env: Env,
  prefix: string,
  memoryStore: Map<string, T>,
  guard: (value: unknown) => value is T
): Promise<T[]> {
  if (env.AI_GATEWAY_KV) {
    const listed = await env.AI_GATEWAY_KV.list({ prefix, limit: MAX_LIST_LIMIT });
    const objects = await Promise.all(listed.keys.map((key) => env.AI_GATEWAY_KV!.get(key.name, "json")));
    return objects.filter(guard);
  }

  return [...memoryStore.values()];
}

async function getStoredObject<T>(
  env: Env,
  key: string,
  memoryStore: Map<string, T>,
  id: string,
  guard: (value: unknown) => value is T
): Promise<T | undefined> {
  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(key, "json");
    return guard(stored) ? stored : undefined;
  }

  return memoryStore.get(id);
}

function normalizeUsage(value: unknown): Pick<UsageRecord, "prompt_tokens" | "completion_tokens" | "total_tokens"> {
  if (!value || typeof value !== "object") {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  const usage = value as Record<string, unknown>;
  const promptTokens = numberOrZero(usage.prompt_tokens);
  const completionTokens = numberOrZero(usage.completion_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isAdminUser(value: unknown): value is AdminUser {
  if (!value || typeof value !== "object") {
    return false;
  }

  const user = value as Partial<AdminUser>;
  return typeof user.id === "string" && typeof user.email === "string" && typeof user.tenant_id === "string";
}

function isAdminApiKey(value: unknown): value is AdminApiKey {
  if (!value || typeof value !== "object") {
    return false;
  }

  const apiKey = value as Partial<AdminApiKey>;
  return typeof apiKey.id === "string" && typeof apiKey.key_hash === "string" && typeof apiKey.user_id === "string";
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<UsageRecord>;
  return typeof record.id === "string" && typeof record.model === "string" && typeof record.request_id === "string";
}

function createApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `tvai_${base64UrlEncode(bytes.buffer)}`;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(digest);
}

function base64UrlEncode(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
