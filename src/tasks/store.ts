import type { AsyncTaskRecord, Env } from "../types";

const MEMORY_TASKS = new Map<string, AsyncTaskRecord>();
const TASK_KV_TTL_SECONDS = 7 * 24 * 60 * 60;
type TaskRow = Record<string, unknown>;

export async function saveTask(env: Env, task: AsyncTaskRecord): Promise<void> {
  if (env.DB) {
    try {
      await saveTaskToD1(env.DB, task, true);
      return;
    } catch (error) {
      if (isMissingD1ColumnError(error, "events")) {
        await saveTaskToD1(env.DB, task, false);
        return;
      }
      if (!isMissingD1TableError(error, "async_tasks")) {
        throw error;
      }
    }
  }

  MEMORY_TASKS.set(task.id, task);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(taskKey(task.id), JSON.stringify(task), {
      expirationTtl: TASK_KV_TTL_SECONDS
    });
  }
}

export async function getTask(env: Env, taskId: string): Promise<AsyncTaskRecord | undefined> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM async_tasks WHERE id = ?").bind(taskId).first<TaskRow>();
      return row ? taskFromRow(row) : undefined;
    } catch (error) {
      if (!isMissingD1TableError(error, "async_tasks")) {
        throw error;
      }
    }
  }

  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(taskKey(taskId), "json");
    if (stored && typeof stored === "object") {
      return stored as AsyncTaskRecord;
    }
  }

  return MEMORY_TASKS.get(taskId);
}

export async function listTasks(env: Env, limit = 25): Promise<AsyncTaskRecord[]> {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 25;
  const boundedLimit = Math.min(Math.max(requestedLimit, 1), 100);

  if (env.DB) {
    try {
      const result = await env.DB.prepare("SELECT * FROM async_tasks ORDER BY created_at DESC LIMIT ?").bind(boundedLimit).all<TaskRow>();
      return (result.results || []).map(taskFromRow);
    } catch (error) {
      if (!isMissingD1TableError(error, "async_tasks")) {
        throw error;
      }
    }
  }

  const kv = env.AI_GATEWAY_KV;

  if (kv) {
    const listed = await kv.list({ prefix: "task:", limit: boundedLimit });
    const tasks = await Promise.all(listed.keys.map((key) => kv.get(key.name, "json")));
    return tasks.filter(isTaskRecord).sort(compareTasksByCreatedAt).slice(0, boundedLimit);
  }

  return [...MEMORY_TASKS.values()].sort(compareTasksByCreatedAt).slice(0, boundedLimit);
}

function taskKey(taskId: string): string {
  return `task:${taskId}`;
}

async function saveTaskToD1(db: D1Database, task: AsyncTaskRecord, includeEvents: boolean): Promise<void> {
  const eventsColumn = includeEvents ? ",\n      events" : "";
  const eventsPlaceholder = includeEvents ? ", ?" : "";
  const eventsUpdate = includeEvents ? ",\n      events = excluded.events" : "";
  const bindValues = [
    task.id,
    task.organization_id,
    task.api_key_id,
    task.type,
    task.model,
    task.upstream_id || null,
    task.plugin_id || null,
    task.provider_execution_mode || null,
    task.provider_task_id || null,
    jsonOrNull(task.provider_context),
    task.status,
    JSON.stringify(task.input || {}),
    jsonOrNull(task.output),
    task.store_output ? 1 : 0,
    task.storage_ttl_seconds,
    task.output_expires_at || null,
    task.callback_url || null,
    jsonOrNull(task.metadata),
    jsonOrNull(task.error),
    task.idempotency_key || null,
    task.next_poll_at || null,
    task.created_at,
    task.updated_at,
    task.completed_at || null,
    ...(includeEvents ? [jsonOrNull(task.events)] : [])
  ];

  await db.prepare(`
    INSERT INTO async_tasks (
      id,
      organization_id,
      api_key_id,
      type,
      model,
      upstream_id,
      plugin_id,
      provider_execution_mode,
      provider_task_id,
      provider_context,
      status,
      input,
      output,
      store_output,
      storage_ttl_seconds,
      output_expires_at,
      callback_url,
      metadata,
      error,
      idempotency_key,
      next_poll_at,
      created_at,
      updated_at,
      completed_at${eventsColumn}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${eventsPlaceholder})
    ON CONFLICT(id) DO UPDATE SET
      organization_id = excluded.organization_id,
      api_key_id = excluded.api_key_id,
      type = excluded.type,
      model = excluded.model,
      upstream_id = excluded.upstream_id,
      plugin_id = excluded.plugin_id,
      provider_execution_mode = excluded.provider_execution_mode,
      provider_task_id = excluded.provider_task_id,
      provider_context = excluded.provider_context,
      status = excluded.status,
      input = excluded.input,
      output = excluded.output,
      store_output = excluded.store_output,
      storage_ttl_seconds = excluded.storage_ttl_seconds,
      output_expires_at = excluded.output_expires_at,
      callback_url = excluded.callback_url,
      metadata = excluded.metadata,
      error = excluded.error,
      idempotency_key = excluded.idempotency_key,
      next_poll_at = excluded.next_poll_at,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at${eventsUpdate}
  `).bind(...bindValues).run();
}

function taskFromRow(row: TaskRow): AsyncTaskRecord {
  return {
    id: stringValue(row.id),
    object: "task",
    organization_id: stringValue(row.organization_id),
    api_key_id: stringValue(row.api_key_id),
    type: stringValue(row.type),
    model: stringValue(row.model),
    upstream_id: optionalString(row.upstream_id),
    plugin_id: optionalString(row.plugin_id),
    provider_execution_mode: optionalString(row.provider_execution_mode),
    provider_task_id: optionalString(row.provider_task_id),
    provider_context: parseJsonObject(row.provider_context),
    status: stringValue(row.status) as AsyncTaskRecord["status"],
    input: parseJsonObject(row.input) || {},
    output: parseJsonArray(row.output) as AsyncTaskRecord["output"],
    store_output: row.store_output === 1 || row.store_output === true,
    storage_ttl_seconds: numberValue(row.storage_ttl_seconds),
    output_expires_at: optionalString(row.output_expires_at) || null,
    callback_url: optionalString(row.callback_url),
    metadata: parseJsonObject(row.metadata),
    error: parseJsonValue(row.error),
    events: parseJsonArray(row.events) as AsyncTaskRecord["events"],
    idempotency_key: optionalString(row.idempotency_key),
    next_poll_at: optionalString(row.next_poll_at),
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at),
    completed_at: optionalString(row.completed_at)
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function parseJsonArray(value: unknown): unknown[] | undefined {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
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

function isTaskRecord(value: unknown): value is AsyncTaskRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<AsyncTaskRecord>;
  return task.object === "task" && typeof task.id === "string";
}

function compareTasksByCreatedAt(left: AsyncTaskRecord, right: AsyncTaskRecord): number {
  return right.created_at.localeCompare(left.created_at);
}
