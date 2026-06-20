import type { AsyncTaskRecord, Env, GatewayConfig, ProviderRouteConfig } from "../types";
import { createId } from "../utils/ids";

const GATEWAY_CONFIG_KEY = "admin:gateway_config";
const USER_PREFIX = "admin:user:";
const API_KEY_PREFIX = "admin:api_key:";
const API_KEY_HASH_PREFIX = "admin:api_key_hash:";
const USAGE_PREFIX = "admin:usage:";
const MAX_LIST_LIMIT = 200;
const D1_GATEWAY_CONFIG_KEY = "default";
type D1Row = Record<string, unknown>;

const MEMORY = {
  gatewayConfig: undefined as GatewayConfig | undefined,
  users: new Map<string, AdminUser>(),
  apiKeys: new Map<string, AdminApiKey>(),
  apiKeyHashes: new Map<string, string>(),
  usage: new Map<string, UsageRecord>()
};

export interface AdminUser {
  id: string;
  organization_id: string;
  email: string;
  name?: string;
  role: "owner" | "admin" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface AdminApiKey {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  encrypted_key?: string;
  encrypted_key_iv?: string;
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
  organization_id: string;
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
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT config_json FROM gateway_configs WHERE key = ?").bind(D1_GATEWAY_CONFIG_KEY).first<D1Row>();
      if (typeof row?.config_json === "string") {
        return JSON.parse(row.config_json) as GatewayConfig;
      }
    } catch (error) {
      if (!isMissingD1TableError(error, "gateway_configs")) {
        throw error;
      }
    }
  }

  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(GATEWAY_CONFIG_KEY, "json");
    if (stored && typeof stored === "object") {
      return stored as GatewayConfig;
    }
  }

  return MEMORY.gatewayConfig;
}

export async function saveManagedGatewayConfig(env: Env, config: GatewayConfig): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO gateway_configs (key, config_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `).bind(D1_GATEWAY_CONFIG_KEY, JSON.stringify(config), new Date().toISOString()).run();
      return;
    } catch (error) {
      if (!isMissingD1TableError(error, "gateway_configs")) {
        throw error;
      }
    }
  }

  MEMORY.gatewayConfig = config;

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(GATEWAY_CONFIG_KEY, JSON.stringify(config));
  }
}

export async function clearManagedGatewayConfig(env: Env): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM gateway_configs WHERE key = ?").bind(D1_GATEWAY_CONFIG_KEY).run();
      return;
    } catch (error) {
      if (!isMissingD1TableError(error, "gateway_configs")) {
        throw error;
      }
    }
  }

  MEMORY.gatewayConfig = undefined;

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.delete(GATEWAY_CONFIG_KEY);
  }
}

export async function listAdminUsers(env: Env): Promise<AdminUser[]> {
  if (env.DB) {
    try {
      const result = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT ?").bind(MAX_LIST_LIMIT).all<D1Row>();
      return (result.results || []).map(adminUserFromRow);
    } catch (error) {
      if (!isMissingD1TableError(error, "users")) {
        throw error;
      }
    }
  }

  return listStoredObjects<AdminUser>(env, USER_PREFIX, MEMORY.users, isAdminUser);
}

export async function getAdminUser(env: Env, userId: string): Promise<AdminUser | undefined> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<D1Row>();
      return row ? adminUserFromRow(row) : undefined;
    } catch (error) {
      if (!isMissingD1TableError(error, "users")) {
        throw error;
      }
    }
  }

  return getStoredObject<AdminUser>(env, `${USER_PREFIX}${userId}`, MEMORY.users, userId, isAdminUser);
}

export async function findAdminUserByEmail(env: Env, email: string): Promise<AdminUser | undefined> {
  const normalizedEmail = email.trim().toLowerCase();
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM users WHERE lower(email) = ? LIMIT 1").bind(normalizedEmail).first<D1Row>();
      return row ? adminUserFromRow(row) : undefined;
    } catch (error) {
      if (!isMissingD1TableError(error, "users")) {
        throw error;
      }
    }
  }

  const users = await listAdminUsers(env);
  return users.find((user) => user.email.toLowerCase() === normalizedEmail);
}

export async function createAdminUser(
  env: Env,
  input: Pick<AdminUser, "email"> & Partial<Pick<AdminUser, "name" | "role" | "status" | "organization_id">>
): Promise<AdminUser> {
  const now = new Date().toISOString();
  const user: AdminUser = {
    id: createId("user"),
    organization_id: input.organization_id || createId("organization"),
    email: input.email.trim().toLowerCase(),
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
  user.email = user.email.trim().toLowerCase();

  if (env.DB) {
    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO organizations (id, name, status, created_at, updated_at)
          VALUES (?, ?, 'active', ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
        `).bind(user.organization_id, "", user.created_at, user.updated_at),
        env.DB.prepare(`
          INSERT INTO users (id, organization_id, email, name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            organization_id = excluded.organization_id,
            email = excluded.email,
            name = excluded.name,
            role = excluded.role,
            status = excluded.status,
            updated_at = excluded.updated_at
        `).bind(
          user.id,
          user.organization_id,
          user.email,
          user.name || "",
          user.role,
          user.status,
          user.created_at,
          user.updated_at
        )
      ]);
      return;
    } catch (error) {
      if (!isMissingD1TableError(error, "organizations") && !isMissingD1TableError(error, "users")) {
        throw error;
      }
    }
  }

  MEMORY.users.set(user.id, user);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(`${USER_PREFIX}${user.id}`, JSON.stringify(user));
  }
}

export async function listAdminApiKeys(env: Env): Promise<AdminApiKey[]> {
  if (env.DB) {
    try {
      const result = await env.DB.prepare("SELECT * FROM api_keys ORDER BY created_at DESC LIMIT ?").bind(MAX_LIST_LIMIT).all<D1Row>();
      return (result.results || []).map(adminApiKeyFromRow);
    } catch (error) {
      if (!isMissingD1TableError(error, "api_keys")) {
        throw error;
      }
    }
  }

  return listStoredObjects<AdminApiKey>(env, API_KEY_PREFIX, MEMORY.apiKeys, isAdminApiKey);
}

export async function getAdminApiKey(env: Env, apiKeyId: string): Promise<AdminApiKey | undefined> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(apiKeyId).first<D1Row>();
      return row ? adminApiKeyFromRow(row) : undefined;
    } catch (error) {
      if (!isMissingD1TableError(error, "api_keys")) {
        throw error;
      }
    }
  }

  return getStoredObject<AdminApiKey>(env, `${API_KEY_PREFIX}${apiKeyId}`, MEMORY.apiKeys, apiKeyId, isAdminApiKey);
}

export async function createAdminApiKey(
  env: Env,
  input: Pick<AdminApiKey, "organization_id" | "user_id" | "name"> & Partial<Pick<AdminApiKey, "allowed_models" | "expires_at">>
): Promise<CreatedAdminApiKey> {
  const now = new Date().toISOString();
  const token = createApiToken();
  const encrypted = await encryptApiToken(token, env);
  const apiKey: AdminApiKey = {
    id: createId("key"),
    organization_id: input.organization_id,
    user_id: input.user_id,
    name: input.name,
    key_hash: await sha256Base64Url(token),
    key_prefix: token.slice(0, 14),
    encrypted_key: encrypted.ciphertext,
    encrypted_key_iv: encrypted.iv,
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

export async function revealAdminApiKeyToken(env: Env, apiKey: AdminApiKey): Promise<string | undefined> {
  if (!apiKey.encrypted_key || !apiKey.encrypted_key_iv) {
    return undefined;
  }
  return decryptApiToken(apiKey.encrypted_key, apiKey.encrypted_key_iv, env);
}

export async function findAdminApiKeyByToken(env: Env, token: string): Promise<AdminApiKey | undefined> {
  const hash = await sha256Base64Url(token);
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1").bind(hash).first<D1Row>();
      return row ? adminApiKeyFromRow(row) : undefined;
    } catch (error) {
      if (!isMissingD1TableError(error, "api_keys")) {
        throw error;
      }
    }
  }

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
  if (env.DB) {
    try {
      await insertAdminApiKey(env.DB, apiKey, true);
      return;
    } catch (error) {
      if (isMissingD1ColumnError(error, "encrypted_key") || isMissingD1ColumnError(error, "encrypted_key_iv")) {
        await insertAdminApiKey(env.DB, apiKey, false);
        return;
      }
      if (!isMissingD1TableError(error, "api_keys")) {
        throw error;
      }
    }
  }

  const previous = MEMORY.apiKeys.get(apiKey.id);
  if (previous && previous.key_hash !== apiKey.key_hash) {
    MEMORY.apiKeyHashes.delete(previous.key_hash);
  }
  MEMORY.apiKeys.set(apiKey.id, apiKey);
  MEMORY.apiKeyHashes.set(apiKey.key_hash, apiKey.id);

  if (env.AI_GATEWAY_KV) {
    await Promise.all([
      env.AI_GATEWAY_KV.put(`${API_KEY_PREFIX}${apiKey.id}`, JSON.stringify(apiKey)),
      env.AI_GATEWAY_KV.put(`${API_KEY_HASH_PREFIX}${apiKey.key_hash}`, apiKey.id)
    ]);
  }
}

async function insertAdminApiKey(db: D1Database, apiKey: AdminApiKey, includeEncryptedFields: boolean): Promise<void> {
  const encryptedColumns = includeEncryptedFields ? ",\n        encrypted_key,\n        encrypted_key_iv" : "";
  const encryptedPlaceholders = includeEncryptedFields ? ", ?, ?" : "";
  const encryptedUpdates = includeEncryptedFields ? ",\n        encrypted_key = excluded.encrypted_key,\n        encrypted_key_iv = excluded.encrypted_key_iv" : "";
  const bindValues = [
    apiKey.id,
    apiKey.organization_id,
    apiKey.user_id,
    apiKey.name,
    apiKey.key_hash,
    apiKey.key_prefix,
    ...(includeEncryptedFields ? [apiKey.encrypted_key || null, apiKey.encrypted_key_iv || null] : []),
    apiKey.allowed_models ? JSON.stringify(apiKey.allowed_models) : null,
    apiKey.status,
    apiKey.expires_at || null,
    apiKey.last_used_at || null,
    apiKey.created_at,
    apiKey.updated_at
  ];

  await db.prepare(`
    INSERT INTO api_keys (
      id,
      organization_id,
      user_id,
      name,
      key_hash,
      key_prefix${encryptedColumns},
      allowed_models,
      status,
      expires_at,
      last_used_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?${encryptedPlaceholders}, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      organization_id = excluded.organization_id,
      user_id = excluded.user_id,
      name = excluded.name,
      key_hash = excluded.key_hash,
      key_prefix = excluded.key_prefix${encryptedUpdates},
      allowed_models = excluded.allowed_models,
      status = excluded.status,
      expires_at = excluded.expires_at,
      last_used_at = excluded.last_used_at,
      updated_at = excluded.updated_at
  `).bind(...bindValues).run();
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
    organization_id: string;
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
    organization_id: input.organization_id,
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
    organization_id: task.organization_id,
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
  if (env.DB) {
    try {
      const result = await env.DB.prepare("SELECT * FROM usage_records ORDER BY created_at DESC LIMIT ?").bind(MAX_LIST_LIMIT).all<D1Row>();
      return (result.results || []).map(usageRecordFromRow);
    } catch (error) {
      if (isMissingUsageTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  return listStoredObjects<UsageRecord>(env, USAGE_PREFIX, MEMORY.usage, isUsageRecord);
}

export async function summarizeUsage(env: Env): Promise<UsageSummary> {
  if (env.DB) {
    try {
      return await summarizeUsageFromD1(env.DB, true);
    } catch (error) {
      if (isMissingUsageTableError(error)) {
        return emptyUsageSummary();
      }
      if (isMissingD1ColumnError(error, "cost")) {
        return summarizeUsageFromD1(env.DB, false);
      }
      throw error;
    }
  }

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

async function summarizeUsageFromD1(db: D1Database, includeCost: boolean): Promise<UsageSummary> {
  const costSelect = includeCost ? "COALESCE(SUM(cost), 0) AS cost" : "0 AS cost";
  const [totalRow, byModelRows, recentRows] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(media_count), 0) AS media_count,
        ${costSelect}
      FROM usage_records
    `).first<D1Row>(),
    db.prepare(`
      SELECT
        model,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(media_count), 0) AS media_count,
        ${costSelect}
      FROM usage_records
      GROUP BY model
      ORDER BY requests DESC
      LIMIT ?
    `).bind(MAX_LIST_LIMIT).all<D1Row>(),
    db.prepare("SELECT * FROM usage_records ORDER BY created_at DESC LIMIT 50").all<D1Row>()
  ]);

  return {
    total_requests: numberValue(totalRow?.total_requests),
    total_tokens: numberValue(totalRow?.total_tokens),
    prompt_tokens: numberValue(totalRow?.prompt_tokens),
    completion_tokens: numberValue(totalRow?.completion_tokens),
    media_count: numberValue(totalRow?.media_count),
    cost: numberValue(totalRow?.cost),
    by_model: (byModelRows.results || []).map((row) => ({
      model: stringValue(row.model),
      requests: numberValue(row.requests),
      total_tokens: numberValue(row.total_tokens),
      prompt_tokens: numberValue(row.prompt_tokens),
      completion_tokens: numberValue(row.completion_tokens),
      media_count: numberValue(row.media_count),
      cost: numberValue(row.cost)
    })),
    recent: (recentRows.results || []).map(usageRecordFromRow)
  };
}

function emptyUsageSummary(): UsageSummary {
  return {
    total_requests: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    media_count: 0,
    cost: 0,
    by_model: [],
    recent: []
  };
}

async function saveUsageRecord(env: Env, record: UsageRecord): Promise<void> {
  if (env.DB) {
    try {
      await insertUsageRecord(env.DB, record, true);
    } catch (error) {
      if (isMissingUsageTableError(error)) {
        return;
      }
      if (isMissingD1ColumnError(error, "cost")) {
        await insertUsageRecord(env.DB, record, false);
        return;
      }
      throw error;
    }
    return;
  }

  MEMORY.usage.set(record.id, record);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(`${USAGE_PREFIX}${record.id}`, JSON.stringify(record));
  }
}

async function insertUsageRecord(db: D1Database, record: UsageRecord, includeCost: boolean): Promise<void> {
  const costColumn = includeCost ? ",\n        cost" : "";
  const costPlaceholder = includeCost ? ", ?" : "";
  const bindValues = [
    record.id,
    record.request_id,
    record.organization_id,
    record.api_key_id,
    record.endpoint,
    record.model,
    record.upstream_id || null,
    record.plugin_id || null,
    record.provider_model || null,
    record.status_code,
    record.latency_ms,
    record.stream ? 1 : 0,
    record.prompt_tokens,
    record.completion_tokens,
    record.total_tokens,
    record.media_count,
    ...(includeCost ? [record.cost] : []),
    record.created_at
  ];

  await db.prepare(`
    INSERT OR IGNORE INTO usage_records (
      id,
      request_id,
      organization_id,
      api_key_id,
      endpoint,
      model,
      upstream_id,
      plugin_id,
      provider_model,
      status_code,
      latency_ms,
      stream,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      media_count${costColumn},
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${costPlaceholder}, ?)
  `).bind(...bindValues).run();
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

function adminUserFromRow(row: D1Row): AdminUser {
  return {
    id: stringValue(row.id),
    organization_id: stringValue(row.organization_id),
    email: stringValue(row.email),
    name: optionalString(row.name),
    role: stringValue(row.role) as AdminUser["role"],
    status: stringValue(row.status) as AdminUser["status"],
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at)
  };
}

function adminApiKeyFromRow(row: D1Row): AdminApiKey {
  return {
    id: stringValue(row.id),
    organization_id: stringValue(row.organization_id),
    user_id: stringValue(row.user_id),
    name: stringValue(row.name),
    key_hash: stringValue(row.key_hash),
    key_prefix: stringValue(row.key_prefix),
    encrypted_key: optionalString(row.encrypted_key),
    encrypted_key_iv: optionalString(row.encrypted_key_iv),
    allowed_models: parseStringArray(row.allowed_models),
    status: stringValue(row.status) as AdminApiKey["status"],
    expires_at: optionalString(row.expires_at) || null,
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
    last_used_at: optionalString(row.last_used_at) || null
  };
}

function usageRecordFromRow(row: D1Row): UsageRecord {
  return {
    id: stringValue(row.id),
    request_id: stringValue(row.request_id),
    organization_id: stringValue(row.organization_id),
    api_key_id: stringValue(row.api_key_id),
    endpoint: stringValue(row.endpoint),
    model: stringValue(row.model),
    upstream_id: optionalString(row.upstream_id),
    plugin_id: optionalString(row.plugin_id),
    provider_model: optionalString(row.provider_model),
    status_code: numberValue(row.status_code),
    latency_ms: numberValue(row.latency_ms),
    stream: row.stream === 1 || row.stream === true,
    prompt_tokens: numberValue(row.prompt_tokens),
    completion_tokens: numberValue(row.completion_tokens),
    total_tokens: numberValue(row.total_tokens),
    media_count: numberValue(row.media_count),
    cost: numberValue(row.cost),
    created_at: stringValue(row.created_at)
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value || 0);
}

function isMissingUsageTableError(error: unknown): boolean {
  return isMissingD1TableError(error, "usage_records");
}

function isMissingD1TableError(error: unknown, table: string): boolean {
  return errorMessage(error).includes(`no such table: ${table.toLowerCase()}`);
}

function isMissingD1ColumnError(error: unknown, column: string): boolean {
  const message = errorMessage(error);
  const normalizedColumn = column.toLowerCase();
  return message.includes(`no such column: ${normalizedColumn}`) || message.includes(`no column named ${normalizedColumn}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
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
  return typeof user.id === "string" && typeof user.email === "string" && typeof user.organization_id === "string";
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

async function encryptApiToken(token: string, env: Env): Promise<{ ciphertext: string; iv: string }> {
  const encryptionKey = await deriveEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    new TextEncoder().encode(token)
  );
  return {
    ciphertext: base64UrlEncode(encrypted),
    iv: base64UrlEncode(iv.buffer)
  };
}

async function decryptApiToken(ciphertext: string, iv: string, env: Env): Promise<string> {
  const encryptionKey = await deriveEncryptionKey(env);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecodeToBuffer(iv) },
    encryptionKey,
    base64UrlDecodeToBuffer(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

async function deriveEncryptionKey(env: Env): Promise<CryptoKey> {
  const token = env.ADMIN_TOKEN || env.USER_CENTER_TOKEN || "teaven-default-encryption-key";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64UrlDecodeToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
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
