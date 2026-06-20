import { findModel, loadGatewayConfig, selectRoute } from "../config";
import { invalidRequest, permissionDenied, providerUnavailable } from "../http/errors";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import { recordChatUsage } from "../admin/store";
import { appendTaskEvent, taskDiagnostics } from "../tasks/events";
import { saveTask } from "../tasks/store";
import type { AuthContext, AsyncTaskRecord, Env, ImageGenerationRequest } from "../types";
import { createId } from "../utils/ids";
import { readJsonObject, requireString } from "../utils/request";

export async function handleAsyncImageGenerations(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const startedAt = Date.now();
  const body = await readJsonObject(request);
  const modelName = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");

  if (body.n !== undefined && (typeof body.n !== "number" || body.n < 1 || body.n > 10)) {
    throw invalidRequest("n must be an integer between 1 and 10", "n");
  }

  if (body.response_format !== undefined && (typeof body.response_format !== "string" || !["url", "b64_json"].includes(body.response_format))) {
    throw invalidRequest('response_format must be "url" or "b64_json"', "response_format");
  }

  if (auth.allowed_models && !auth.allowed_models.includes(modelName)) {
    throw permissionDenied(`API key cannot access model: ${modelName}`);
  }

  const config = await loadGatewayConfig(env);
  const model = findModel(config, modelName);
  if (!model) {
    throw invalidRequest(`Unknown model: ${modelName}`, "model", "model_not_found");
  }

  if (model.modality !== "image") {
    throw invalidRequest(
      `Model is not an image model: ${modelName}. Use /v1/chat/completions for text models.`,
      "model"
    );
  }

  const route = selectRoute(model, false);
  if (!route) {
    throw providerUnavailable(`No active provider route for model: ${modelName}`);
  }

  const registry = createProviderRegistry(env);
  const plugin = registry.get(route.plugin_id);
  const adapter = plugin.createAdapter(env);
  
  if (!adapter.imageGenerations) {
    throw providerUnavailable(`Provider plugin does not support image generation: ${route.plugin_id}`);
  }

  const credential = resolveProviderCredential(env, route);
  
  // 调用上游异步接口
  const upstreamResponse = await adapter.imageGenerations(body as ImageGenerationRequest, {
    env,
    request_id: requestId,
    route,
    credential,
    signal: request.signal
  });

  // 解析上游响应
  const upstreamData = await upstreamResponse.json() as Record<string, unknown>;
  
  // 如果上游返回202异步响应，创建本地任务记录
  if (upstreamResponse.status === 202) {
    const providerTaskId = firstString(upstreamData.id, upstreamData.provider_task_id, upstreamData.task_id);
    if (!providerTaskId) {
      throw providerUnavailable("Upstream async response did not include provider_task_id");
    }

    const now = new Date().toISOString();
    const task: AsyncTaskRecord = {
      id: createId("task"),
      object: "task",
      organization_id: auth.organization_id,
      api_key_id: auth.api_key_id,
      type: "image",
      model: modelName,
      upstream_id: route.upstream_id,
      plugin_id: route.plugin_id,
      provider_execution_mode: "async_polling",
      provider_task_id: providerTaskId,
      provider_context: {
        upstream_model: route.provider_model,
        request_id: requestId,
        base_url: route.base_url,
        credential_id: route.credential_id,
        config: route.config
      },
      status: "queued",
      input: body as Record<string, unknown>,
      store_output: true,
      storage_ttl_seconds: 24 * 60 * 60,
      output_expires_at: null,
      callback_url: body.callback_url as string | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
      idempotency_key: request.headers.get("Idempotency-Key") || undefined,
      created_at: now,
      updated_at: now
    };

    appendTaskEvent(task, {
      stage: "task.created",
      status: task.status,
      request_id: requestId,
      provider_task_id: task.provider_task_id,
      message: "Task created via /v1/async/images/generations"
    });

    await saveTask(env, task);

    // 将任务加入队列进行轮询
    await enqueueCreatedTask(env, task);

    await recordChatUsage(env, {
      request_id: requestId,
      organization_id: auth.organization_id,
      api_key_id: auth.api_key_id,
      endpoint: "/v1/async/images/generations",
      model: modelName,
      route,
      status_code: 202,
      latency_ms: Date.now() - startedAt,
      stream: false,
      usage: undefined
    });

    // 返回任务ID给客户端
    return new Response(
      JSON.stringify({
        id: task.id,
        object: "task",
        type: "image",
        status: task.status,
        provider_task_id: task.provider_task_id,
        diagnostics: taskDiagnostics(task),
        events: task.events || [],
        created_at: task.created_at,
        updated_at: task.updated_at
      }),
      {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId
        }
      }
    );
  }

  // 如果上游直接返回结果（同步模式），转发响应
  await recordChatUsage(env, {
    request_id: requestId,
    organization_id: auth.organization_id,
    api_key_id: auth.api_key_id,
    endpoint: "/v1/async/images/generations",
    model: modelName,
    route,
    status_code: upstreamResponse.status,
    latency_ms: Date.now() - startedAt,
    stream: false,
    usage: undefined
  });

  return new Response(JSON.stringify(upstreamData), {
    status: upstreamResponse.status,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId
    }
  });
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
