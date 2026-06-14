import { conflict, invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import { recordTaskUsage } from "../admin/store";
import { getTask, saveTask } from "../tasks/store";
import type { AsyncTaskRecord, AuthContext, Env } from "../types";
import { createId } from "../utils/ids";
import { optionalString, readJsonObject, requireObject, requireString } from "../utils/request";

const DEFAULT_STORAGE_TTL_SECONDS = 24 * 60 * 60;

export async function handleCreateTask(request: Request, env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const type = requireString(body.type, "type");
  const model = requireString(body.model, "model");
  const input = requireObject(body.input, "input");
  const callbackUrl = optionalString(body.callback_url, "callback_url");
  const metadata = body.metadata === undefined ? undefined : requireObject(body.metadata, "metadata");
  const storeOutput = body.store_output === true;
  const storageTtlSeconds = normalizeStorageTtl(body.storage_ttl_seconds);
  const now = new Date().toISOString();

  if (body.store_output !== undefined && typeof body.store_output !== "boolean") {
    throw invalidRequest("store_output must be a boolean", "store_output");
  }

  const task: AsyncTaskRecord = {
    id: createId("task"),
    object: "task",
    tenant_id: auth.tenant_id,
    api_key_id: auth.api_key_id,
    type,
    model,
    status: "queued",
    input,
    store_output: storeOutput,
    storage_ttl_seconds: storageTtlSeconds,
    output_expires_at: null,
    callback_url: callbackUrl,
    metadata,
    idempotency_key: request.headers.get("Idempotency-Key") || undefined,
    created_at: now,
    updated_at: now
  };

  await saveTask(env, task);

  if (env.TASK_QUEUE) {
    await env.TASK_QUEUE.send({ task_id: task.id });
  }

  await recordTaskUsage(env, task, 202, Date.now() - startedAt);

  return jsonResponse(publicTask(task), {
    status: 202,
    headers: {
      "X-Request-Id": requestId
    }
  });
}

export async function handleGetTask(taskId: string, env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.tenant_id !== auth.tenant_id) {
    throw notFound("Task not found");
  }

  return jsonResponse(publicTask(task), {
    headers: {
      "X-Request-Id": requestId
    }
  });
}

export async function handleCancelTask(taskId: string, env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.tenant_id !== auth.tenant_id) {
    throw notFound("Task not found");
  }

  if (!["queued", "running"].includes(task.status)) {
    throw conflict(`Task cannot be canceled from status: ${task.status}`);
  }

  const now = new Date().toISOString();
  task.status = "canceled";
  task.updated_at = now;
  task.completed_at = now;
  await saveTask(env, task);

  return jsonResponse(publicTask(task), {
    headers: {
      "X-Request-Id": requestId
    }
  });
}

function normalizeStorageTtl(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_STORAGE_TTL_SECONDS;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidRequest("storage_ttl_seconds must be an integer", "storage_ttl_seconds");
  }

  if (value < 1 || value > DEFAULT_STORAGE_TTL_SECONDS) {
    throw invalidRequest("storage_ttl_seconds must be between 1 and 86400", "storage_ttl_seconds");
  }

  return value;
}

function publicTask(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    object: task.object,
    type: task.type,
    status: task.status,
    model: task.model,
    output: task.output,
    usage: undefined,
    store_output: task.store_output,
    storage_ttl_seconds: task.storage_ttl_seconds,
    output_expires_at: task.output_expires_at,
    callback_url: task.callback_url,
    metadata: task.metadata,
    error: task.error,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at
  };
}
