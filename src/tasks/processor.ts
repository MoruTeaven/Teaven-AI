/**
 * 异步任务处理器 — Queue Consumer 的核心编排逻辑。
 *
 * 生命周期：
 *   queued → processor 接手 → running → 轮询上游 → succeeded / failed / expired
 *
 * 每一步的耗时、状态变更都会记录在 AsyncTaskRecord.updated_at 和 events 上，
 * 可通过 GET /v1/tasks/:id 实时查询状态链。
 */
import type { AsyncTaskOutputItem, AsyncTaskRecord, Env, ProviderRouteConfig } from "../types";
import type { ImageGenerationRequest } from "../types";
import { ApiError } from "../http/errors";
import type { ProviderCredential, ProviderRequestContext, TaskPollResult } from "../providers/types";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { appendTaskEvent, taskDiagnostics } from "../tasks/events";
import { publicTaskOutput } from "../tasks/output";
import { getTask, saveTask } from "../tasks/store";
import { recordTaskUsage } from "../admin/store";
import { createId } from "../utils/ids";

/** 最多轮询次数，超过后任务标记为 expired */
const MAX_POLL_ATTEMPTS = 300;
/** 上游创建阶段最多重试次数，避免无 provider_task_id 的 running 任务永久卡住 */
const MAX_CREATE_ATTEMPTS = 10;

export async function processTask(env: Env, taskId: string): Promise<void> {
  const processId = createId("proc");
  const startedAt = Date.now();

  // ── 1. 加载任务 ──
  const task = await loadTask(env, taskId);
  if (!task) {
    console.warn(`[processor ${processId}] task not found: ${taskId}, skipping`);
    return;
  }

  // ── 2. 状态守卫：只处理 queued / running ──
  if (!isProcessable(task.status)) {
    console.log(
      `[processor ${processId}] task ${taskId} is in terminal state "${task.status}", skipping`
    );
    return;
  }

  // ── 3. 把 queued 转为 running ──
  if (task.status === "queued") {
    const previousStatus = task.status;
    task.status = "running";
    task.updated_at = new Date().toISOString();
    appendTaskEvent(task, {
      stage: "processor.started",
      previous_status: previousStatus,
      status: task.status,
      process_id: processId,
      message: "Queue consumer picked up the task"
    });
    await saveTask(env, task);
  }

  // ── 4. 没有插件上下文的任务无法处理 ──
  if (!task.plugin_id || !task.provider_context) {
    markFailed(task, {
      message: "Task has no plugin_id or provider_context, cannot be processed by consumer"
    }, {
      stage: "task.failed",
      process_id: processId,
      message: "Missing provider routing context"
    });
    await persistTask(env, task, startedAt);
    return;
  }

  // ── 5. 没有 provider_task_id 的任务：需要先调用上游创建 ──
  if (!task.provider_task_id) {
    const createAttempt = readCounter(task.provider_context._create_attempt_count) + 1;
    task.provider_context._create_attempt_count = createAttempt;

    try {
      await createUpstreamTask(env, task, processId, createAttempt);
    } catch (err) {
      const message = errorMessage(err);
      task.provider_context._last_error = message;
      if (err instanceof ApiError) {
        task.provider_context._last_http_status = err.status;
        task.provider_context._last_provider_code = err.code;
      }
      appendTaskEvent(task, {
        stage: "upstream.create.error",
        status: task.status,
        attempt: createAttempt,
        process_id: processId,
        error: message
      });

      const permanentCreateError = isPermanentCreateError(err);
      if (permanentCreateError || createAttempt >= MAX_CREATE_ATTEMPTS) {
        markFailed(task, {
          message: permanentCreateError
            ? "Upstream task creation failed with a non-retryable error"
            : `Upstream task creation failed after ${MAX_CREATE_ATTEMPTS} attempts`,
          cause: message
        }, {
          stage: "task.failed",
          process_id: processId,
          message: permanentCreateError ? "Upstream creation returned a non-retryable error" : "Exceeded max upstream creation attempts"
        });
      }
    }

    // 创建后重新入队（下一轮 consumer 拿到 provider_task_id 后开始轮询）。
    // 如果创建阶段只是临时异常，也重新入队重试，避免任务停在 running 且没有 provider_task_id。
    if (!isTerminal(task.status)) {
      await reEnqueue(env, task);
    }
    await persistTask(env, task, startedAt);
    if (isCallbackTerminal(task.status)) {
      await deliverCallback(env, task, processId);
    }
    return;
  }

  // ── 6. 检查轮询次数是否超限 ──
  const pollCount = (task.provider_context._poll_count as number) || 0;
  if (pollCount >= MAX_POLL_ATTEMPTS) {
    task.status = "expired";
    task.error = { message: `Exceeded max poll attempts (${MAX_POLL_ATTEMPTS})`, poll_count: pollCount };
    task.completed_at = new Date().toISOString();
    task.updated_at = task.completed_at;
    appendTaskEvent(task, {
      stage: "task.expired",
      status: task.status,
      attempt: pollCount,
      process_id: processId,
      message: `Exceeded max poll attempts (${MAX_POLL_ATTEMPTS})`
    });
    await persistTask(env, task, startedAt);
    return;
  }

  // ── 7. 重建路由上下文 → 调用 Provider.pollTask ──
  const ctx = buildRequestContext(env, task, processId);
  if (!ctx) {
    markFailed(task, { message: "Cannot build provider request context from task record" }, {
      stage: "task.failed",
      process_id: processId,
      message: "Cannot build provider request context from task record"
    });
    await persistTask(env, task, startedAt);
    return;
  }

  let pollResult: TaskPollResult;
  const pollAttempt = pollCount + 1;
  const pollStartedAt = new Date().toISOString();
  task.provider_context._last_poll_at = pollStartedAt;
  appendTaskEvent(task, {
    stage: "poll.started",
    status: task.status,
    attempt: pollAttempt,
    process_id: processId,
    provider_task_id: task.provider_task_id,
    credential_ref: task.credential_ref || null,
    message: "Polling upstream task status"
  });

  try {
    const registry = createProviderRegistry(env);
    const plugin = registry.get(task.plugin_id!);
    const adapter = plugin.createAdapter(env);
    if (!adapter.pollTask) {
      markFailed(task, { message: `Provider "${task.plugin_id}" does not implement pollTask` }, {
        stage: "task.failed",
        process_id: processId,
        message: "Provider does not implement pollTask"
      });
      await persistTask(env, task, startedAt);
      return;
    }
    pollResult = await adapter.pollTask(task.provider_task_id!, task, ctx);
  } catch (err) {
    // 网络/上游异常 → 退避重试，不立即标记失败
    console.error(`[processor ${processId}] pollTask error for ${taskId}:`, err);
    task.provider_context._poll_count = pollAttempt;
    task.provider_context._last_error = errorMessage(err);
    appendTaskEvent(task, {
      stage: "poll.error",
      status: task.status,
      attempt: pollAttempt,
      process_id: processId,
      provider_task_id: task.provider_task_id,
      error: errorMessage(err)
    });
    task.updated_at = new Date().toISOString();
    await reEnqueue(env, task);
    await persistTask(env, task, startedAt);
    return;
  }

  // ── 8. 更新轮询计数 ──
  task.provider_context._poll_count = pollAttempt;
  if (pollResult.provider_status) {
    task.provider_context._last_provider_status = pollResult.provider_status;
  }
  if (pollResult.provider_response_code) {
    task.provider_context._last_provider_code = pollResult.provider_response_code;
  }
  if (pollResult.http_status) {
    task.provider_context._last_http_status = pollResult.http_status;
  }
  if (pollResult.message) {
    task.provider_context._last_provider_message = pollResult.message;
  }
  if (pollResult.provider_task_id) {
    task.provider_task_id = pollResult.provider_task_id;
  }

  appendTaskEvent(task, {
    stage: "poll.result",
    status: pollResult.status,
    attempt: pollAttempt,
    process_id: processId,
    provider_task_id: task.provider_task_id,
    poll_url: pollResult.poll_url || null,
    provider_status: pollResult.provider_status || null,
    provider_response_code: pollResult.provider_response_code || null,
    http_status: pollResult.http_status,
    message: pollResult.message,
    details: {
      output_count: pollResult.output?.length || 0,
      poll_url: pollResult.poll_url || null,
      upstream_raw_body: pollResult.upstream_raw_body || null
    }
  });

  // ── 9. 按上游状态走分支 ──
  const now = new Date().toISOString();

  switch (pollResult.status) {
    case "succeeded":
      task.status = "succeeded";
      task.completed_at = now;

      // 处理输出：如果开启了 store_output，转存文件到 R2
      if (pollResult.output && pollResult.output.length > 0) {
        if (task.store_output) {
          appendTaskEvent(task, {
            stage: "output.store.started",
            status: task.status,
            process_id: processId,
            details: { output_count: pollResult.output.length }
          });
        }
        task.output = await storeOutputFiles(env, task, pollResult.output, processId);
        if (task.store_output && task.output.length > 0) {
          const expiresAt = new Date(Date.now() + task.storage_ttl_seconds * 1000).toISOString();
          task.output_expires_at = expiresAt;
          appendTaskEvent(task, {
            stage: "output.store.completed",
            status: task.status,
            process_id: processId,
            details: {
              output_count: task.output.length,
              stored_count: task.output.filter((item) => item.stored).length,
              output_expires_at: expiresAt
            }
          });
        }
      }
      appendTaskEvent(task, {
        stage: "task.succeeded",
        status: task.status,
        process_id: processId
      });
      break;

    case "failed":
      task.status = "failed";
      task.error = pollResult.error || { message: "Upstream task failed" };
      task.completed_at = now;
      appendTaskEvent(task, {
        stage: "task.failed",
        status: task.status,
        process_id: processId,
        provider_task_id: task.provider_task_id,
        provider_status: pollResult.provider_status || null,
        provider_response_code: pollResult.provider_response_code || null,
        http_status: pollResult.http_status,
        error: task.error,
        details: {
          poll_url: pollResult.poll_url || null,
          upstream_raw_body: pollResult.upstream_raw_body || null
        }
      });
      break;

    case "canceled":
      task.status = "canceled";
      task.completed_at = now;
      appendTaskEvent(task, {
        stage: "task.canceled",
        status: task.status,
        process_id: processId,
        provider_status: pollResult.provider_status || null
      });
      break;

    case "running":
    case "queued":
    default:
      // 上游仍在处理中 → 重新入队等待下次轮询
      task.updated_at = now;
      await reEnqueue(env, task, pollResult.poll_after_seconds);
      break;
  }

  // ── 10. 持久化 & 回调 ──
  await persistTask(env, task, startedAt);

  if (isCallbackTerminal(task.status)) {
    await deliverCallback(env, task, processId);
  }
}

// ── 内部辅助函数 ──

async function loadTask(env: Env, taskId: string): Promise<AsyncTaskRecord | undefined> {
  return getTask(env, taskId);
}

function isProcessable(status: string): boolean {
  return status === "queued" || status === "running";
}

function markFailed(
  task: AsyncTaskRecord,
  error: unknown,
  event?: { stage?: string; process_id?: string; message?: string }
): void {
  const now = new Date().toISOString();
  const previousStatus = task.status;
  task.status = "failed";
  task.error = error;
  task.completed_at = now;
  task.updated_at = now;
  if (task.provider_context) {
    task.provider_context._last_error = errorMessage(error);
  }

  if (event) {
    appendTaskEvent(task, {
      stage: event.stage || "task.failed",
      previous_status: previousStatus,
      status: task.status,
      process_id: event.process_id,
      message: event.message,
      error
    });
  }
}

async function persistTask(env: Env, task: AsyncTaskRecord, startedAt: number): Promise<void> {
  task.updated_at = new Date().toISOString();
  await saveTask(env, task);

  // 记录用量（终态时），requested_model 便于通过 request_id 反查组别名
  if (isTerminal(task.status)) {
    await recordTaskUsage(
      env,
      task,
      task.status === "succeeded" ? 200 : 500,
      Date.now() - startedAt,
      task.requested_model
    );
  }
}

function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "canceled", "expired"].includes(status);
}

function isCallbackTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

async function reEnqueue(env: Env, task: AsyncTaskRecord, requestedDelaySeconds?: number): Promise<void> {
  // 从 manifest 获取轮询间隔
  const delaySeconds = normalizeDelaySeconds(requestedDelaySeconds, getPollInterval(env, task.plugin_id || "", 5));
  task.next_poll_at = new Date(Date.now() + delaySeconds * 1000).toISOString();

  if (!env.TASK_QUEUE) {
    appendTaskEvent(task, {
      stage: "queue.unavailable",
      status: task.status,
      delay_seconds: delaySeconds,
      message: "TASK_QUEUE binding is not configured"
    });
    return;
  }

  // 通过 msg 的 delay 字段推迟消息投递（仅在支持 delay 的 queue 实现上生效）
  try {
    await env.TASK_QUEUE.send({ task_id: task.id }, { delaySeconds });
    appendTaskEvent(task, {
      stage: "queue.reenqueued",
      status: task.status,
      delay_seconds: delaySeconds,
      message: "Task scheduled for the next processor run"
    });
  } catch {
    // 部分 queue 实现不支持 delaySeconds，直接发送
    try {
      await env.TASK_QUEUE.send({ task_id: task.id });
      appendTaskEvent(task, {
        stage: "queue.reenqueued",
        status: task.status,
        delay_seconds: 0,
        message: "Task scheduled without delayed delivery"
      });
    } catch (err) {
      appendTaskEvent(task, {
        stage: "queue.reenqueue_failed",
        status: task.status,
        delay_seconds: delaySeconds,
        error: errorMessage(err)
      });
    }
  }
}

function normalizeDelaySeconds(requestedDelaySeconds: number | undefined, fallback: number): number {
  if (typeof requestedDelaySeconds === "number" && Number.isFinite(requestedDelaySeconds) && requestedDelaySeconds >= 0) {
    return Math.trunc(requestedDelaySeconds);
  }
  return fallback;
}

function getPollInterval(env: Env, pluginId: string, fallback: number): number {
  try {
    const registry = createProviderRegistry(env);
    const plugin = registry.get(pluginId);
    const cap = plugin.manifest.capabilities["image"];
    return cap?.poll_interval_seconds || fallback;
  } catch {
    return fallback;
  }
}

function buildRequestContext(
  env: Env,
  task: AsyncTaskRecord,
  processId: string
): ProviderRequestContext | null {
  const ctx = task.provider_context!;
  const route: ProviderRouteConfig = {
    upstream_id: task.upstream_id || "",
    plugin_id: task.plugin_id || "",
    provider_model: (ctx.upstream_model as string) || task.model,
    base_url: ctx.base_url as string | undefined,
    credential_id: ctx.credential_id as string | undefined,
    config: ctx.config as Record<string, unknown> | undefined,
    modality: "image"
  };

  let credential: ProviderCredential;
  try {
    credential = resolveProviderCredential(env, route);
  } catch {
    return null;
  }

  return {
    env,
    request_id: processId,
    route,
    credential
  };
}

/**
 * 对于还没有 provider_task_id 的任务，先调用上游同步/异步创建接口，
 * 拿到 provider_task_id 后写回任务记录。
 */
async function createUpstreamTask(env: Env, task: AsyncTaskRecord, processId: string, attempt: number): Promise<void> {
  const ctx = buildRequestContext(env, task, processId);
  if (!ctx) {
    markFailed(task, { message: "Cannot build request context for upstream task creation" }, {
      stage: "task.failed",
      process_id: processId,
      message: "Cannot build provider request context"
    });
    return;
  }

  appendTaskEvent(task, {
    stage: "upstream.create.started",
    status: task.status,
    attempt,
    process_id: processId,
    credential_ref: task.credential_ref || null,
    message: "Creating upstream async task"
  });

  const registry = createProviderRegistry(env);
  const plugin = registry.get(task.plugin_id!);
  const adapter = plugin.createAdapter(env);

  // 根据任务类型调用对应的创建方法
  if (task.type === "image") {
    if (!adapter.imageGenerations) {
      markFailed(task, { message: `Provider "${task.plugin_id}" does not support image generation` }, {
        stage: "task.failed",
        process_id: processId,
        message: "Provider does not support image generation"
      });
      return;
    }

    const reqBody: ImageGenerationRequest = {
      ...(task.input as Record<string, unknown>),
      model: task.model,
      prompt: (task.input.prompt as string) || "",
      n: (task.input.n as number | undefined) || 1,
      response_format: (task.input.response_format as "url" | "b64_json" | undefined) || "url"
    };

    const response = await adapter.imageGenerations(reqBody, ctx);
    const data = (await response.json()) as Record<string, unknown>;
    const providerStatus = firstString(data.status, readObject(data.data)?.status);
    const providerCode = firstString(data.code);
    task.provider_context = task.provider_context || {};
    task.provider_context._last_http_status = response.status;
    if (providerStatus) {
      task.provider_context._last_provider_status = providerStatus;
    }
    if (providerCode) {
      task.provider_context._last_provider_code = providerCode;
    }

    if (response.status === 202) {
      // 异步模式 → 拿到 provider_task_id
      const providerTaskId = firstString(data.id, data.task_id, data.provider_task_id);
      if (!providerTaskId) {
        markFailed(task, {
          message: "Upstream creation returned 202 without provider_task_id",
          response: data
        }, {
          stage: "upstream.create.failed",
          process_id: processId,
          message: "Missing provider_task_id in upstream creation response"
        });
        return;
      }

      task.provider_task_id = providerTaskId;
      task.provider_execution_mode = "async_polling";
      task.updated_at = new Date().toISOString();
      appendTaskEvent(task, {
        stage: "upstream.create.succeeded",
        status: task.status,
        attempt,
        process_id: processId,
        provider_task_id: task.provider_task_id,
        provider_status: providerStatus || null,
        provider_response_code: providerCode || null,
        http_status: response.status
      });
    } else if (response.ok) {
      // 上游同步返回了结果 → 直接完成
      task.status = "succeeded";
      task.completed_at = new Date().toISOString();
      task.output = extractOutputFromResponse(data, task);
      appendTaskEvent(task, {
        stage: "upstream.create.completed_sync",
        status: task.status,
        attempt,
        process_id: processId,
        provider_status: providerStatus || null,
        provider_response_code: providerCode || null,
        http_status: response.status,
        details: { output_count: task.output.length }
      });
      appendTaskEvent(task, {
        stage: "task.succeeded",
        status: task.status,
        process_id: processId
      });
    } else {
      markFailed(task, { message: `Upstream creation failed: ${JSON.stringify(data)}` }, {
        stage: "upstream.create.failed",
        process_id: processId,
        message: "Upstream creation returned a non-success response"
      });
    }
  } else {
    markFailed(task, { message: `Unsupported task type for auto-creation: ${task.type}` }, {
      stage: "task.failed",
      process_id: processId,
      message: "Unsupported task type for upstream creation"
    });
  }
}

function extractOutputFromResponse(data: Record<string, unknown>, task: AsyncTaskRecord): AsyncTaskOutputItem[] {
  const images = data.data as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(images)) {
    return images.map((img, index) => ({
      type: "image",
      url: img.url as string | undefined,
      b64_json: img.b64_json as string | undefined,
      index,
      source: "upstream" as const
    }));
  }
  return [{ type: "image", url: data.url as string, source: "upstream" }];
}

function readCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function isPermanentCreateError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * 如果任务开启了 store_output，下载上游文件转存到 R2，
 * 并返回带有 R2 URL 的新 output 列表。
 */
async function storeOutputFiles(
  env: Env,
  task: AsyncTaskRecord,
  output: AsyncTaskOutputItem[],
  processId: string
): Promise<AsyncTaskOutputItem[]> {
  if (!task.store_output || !output.length) {
    return output;
  }

  const stored: AsyncTaskOutputItem[] = [];
  for (const item of output) {
    if (!item.url) {
      stored.push(item);
      continue;
    }

    try {
      // 跳过已经是自己 R2 的 URL
      if (item.source === "r2" || item.stored) {
        stored.push(item);
        continue;
      }

      const response = await fetch(item.url);
      if (!response.ok || !response.body) {
        console.warn(`[processor ${processId}] failed to download output: ${item.url}, status ${response.status}`);
        stored.push(item); // 保留原始 URL
        continue;
      }

      if (env.FILES) {
        const objectKey = `tasks/${task.id}/${createId("file")}.png`;
        await env.FILES.put(objectKey, response.body, {
          httpMetadata: { contentType: response.headers.get("Content-Type") || "image/png" }
        });
        stored.push({
          ...item,
          url: objectKey, // R2 key 作为 URL
          stored: true,
          source: "r2"
        });
      } else {
        stored.push(item); // 没绑定 R2，保留原始 URL
      }
    } catch (err) {
      console.error(`[processor ${processId}] R2 store error for ${item.url}:`, err);
      stored.push(item); // 出错保留原始 URL
    }
  }

  return stored;
}

/**
 * 投递 callback：向任务的 callback_url POST 任务最终结果。
 */
async function deliverCallback(env: Env, task: AsyncTaskRecord, processId: string): Promise<void> {
  if (!task.callback_url) return;

  appendTaskEvent(task, {
    stage: "callback.deliver_started",
    status: task.status,
    process_id: processId,
    message: "Delivering terminal task webhook"
  });

  try {
    const payload = {
      id: task.id,
      object: task.object,
      type: task.type,
      // 对外展示用组别名（若用户请求的是组），否则用实际模型
      model: task.requested_model || task.model,
      status: task.status,
      output: await publicTaskOutput(task.output, env),
      error: task.error,
      metadata: task.metadata,
      diagnostics: taskDiagnostics(task),
      events: task.events,
      created_at: task.created_at,
      completed_at: task.completed_at
    };

    const response = await fetch(task.callback_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.warn(
        `[processor ${processId}] callback to ${task.callback_url} returned ${response.status}`
      );
      appendTaskEvent(task, {
        stage: "callback.delivery_failed",
        status: task.status,
        process_id: processId,
        http_status: response.status,
        message: "Callback endpoint returned non-2xx status"
      });
    } else {
      appendTaskEvent(task, {
        stage: "callback.delivered",
        status: task.status,
        process_id: processId,
        http_status: response.status
      });
    }
  } catch (err) {
    console.error(`[processor ${processId}] callback delivery failed for task ${task.id}:`, err);
    appendTaskEvent(task, {
      stage: "callback.delivery_failed",
      status: task.status,
      process_id: processId,
      error: errorMessage(err)
    });
  }

  task.updated_at = new Date().toISOString();
  await saveTask(env, task);
}
