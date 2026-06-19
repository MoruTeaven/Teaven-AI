import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { conflict, invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import { recordTaskUsage } from "../admin/store";
import { appendTaskEvent, taskDiagnostics } from "../tasks/events";
import { getTask, listTasks, saveTask } from "../tasks/store";
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

  // 尝试解析模型 → 路由 → 插件，为 Queue Consumer 提供上游上下文
  let upstreamId: string | undefined;
  let pluginId: string | undefined;
  let providerContext: Record<string, unknown> | undefined;

  try {
    const config = await loadGatewayConfig(env);
    const modelCfg = findModel(config, model);
    if (modelCfg) {
      const route = selectRoute(modelCfg, false);
      if (route) {
        upstreamId = route.upstream_id;
        pluginId = route.plugin_id;
        providerContext = {
          upstream_model: route.provider_model,
          request_id: requestId,
          base_url: route.base_url,
          credential_id: route.credential_id,
          config: route.config
        };
      }
    }
  } catch {
    // 配置加载失败不阻塞任务创建，consumer 会跳过无法处理的任务
  }

  const task: AsyncTaskRecord = {
    id: createId("task"),
    object: "task",
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    type,
    model,
    upstream_id: upstreamId,
    plugin_id: pluginId,
    provider_context: providerContext,
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

  appendTaskEvent(task, {
    stage: "task.created",
    status: task.status,
    request_id: requestId,
    message: "Task created via /v1/tasks"
  });

  await saveTask(env, task);

  await enqueueCreatedTask(env, task);

  await recordTaskUsage(env, task, 202, Date.now() - startedAt);

  return jsonResponse(publicTask(task), {
    status: 202,
    headers: {
      "X-Request-Id": requestId
    }
  });
}

export async function handleListTasks(request: Request, env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 1), 100);
  const after = url.searchParams.get("after") || undefined;

  const allTasks = await listTasks(env, limit + 1);
  const myTasks = allTasks.filter((t) => t.organization_id === auth.organization_id);

  let hasMore = false;
  if (after) {
    const afterIndex = myTasks.findIndex((t) => t.id === after);
    const slice = afterIndex >= 0 ? myTasks.slice(afterIndex + 1) : myTasks;
    hasMore = slice.length > limit;
    const result = slice.slice(0, limit);
    return jsonResponse({
      object: "list",
      data: result.map((task) => publicTask(task, false)),
      has_more: hasMore,
      first_id: result[0]?.id || null,
      last_id: result[result.length - 1]?.id || null
    }, { headers: { "X-Request-Id": requestId } });
  }

  hasMore = myTasks.length > limit;
  const result = myTasks.slice(0, limit);
  return jsonResponse({
    object: "list",
    data: result.map((task) => publicTask(task, false)),
    has_more: hasMore,
    first_id: result[0]?.id || null,
    last_id: result[result.length - 1]?.id || null
  }, { headers: { "X-Request-Id": requestId } });
}

export async function handleGetTask(taskId: string, env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.organization_id !== auth.organization_id) {
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
  if (!task || task.organization_id !== auth.organization_id) {
    throw notFound("Task not found");
  }

  if (!["queued", "running"].includes(task.status)) {
    throw conflict(`Task cannot be canceled from status: ${task.status}`);
  }

  const now = new Date().toISOString();
  const previousStatus = task.status;
  task.status = "canceled";
  task.updated_at = now;
  task.completed_at = now;
  appendTaskEvent(task, {
    stage: "task.canceled",
    previous_status: previousStatus,
    status: task.status,
    request_id: requestId,
    message: "Task canceled by API request"
  });
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

async function enqueueCreatedTask(env: Env, task: AsyncTaskRecord): Promise<void> {
  if (!env.TASK_QUEUE) {
    appendTaskEvent(task, {
      stage: "queue.unavailable",
      status: task.status,
      message: "TASK_QUEUE binding is not configured"
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
    return;
  }

  try {
    await env.TASK_QUEUE.send({ task_id: task.id });
    appendTaskEvent(task, {
      stage: "queue.enqueued",
      status: task.status,
      message: "Task submitted to TASK_QUEUE"
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
  } catch (err) {
    appendTaskEvent(task, {
      stage: "queue.enqueue_failed",
      status: task.status,
      error: errorMessage(err)
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
    throw err;
  }
}

function publicTask(task: AsyncTaskRecord, includeEvents = true): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: task.id,
    object: task.object,
    type: task.type,
    status: task.status,
    model: task.model,
    upstream_id: task.upstream_id || null,
    plugin_id: task.plugin_id || null,
    provider_execution_mode: task.provider_execution_mode || null,
    provider_task_id: task.provider_task_id || null,
    output: task.output,
    usage: undefined,
    store_output: task.store_output,
    storage_ttl_seconds: task.storage_ttl_seconds,
    output_expires_at: task.output_expires_at,
    callback_url: task.callback_url,
    metadata: task.metadata,
    error: task.error,
    diagnostics: taskDiagnostics(task),
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at
  };

  if (includeEvents) {
    payload.events = task.events || [];
  }

  return payload;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
