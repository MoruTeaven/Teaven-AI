import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_TTL_SECONDS,
  authenticateAccount,
  createAccountSession,
  findAccountUser,
  isAccountCenterConfigured,
  verifyAccountAccessToken
} from "../auth/account";
import { listModels, loadGatewayConfig, findModel, selectRoute } from "../config";
import { conflict, invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import {
  createAdminApiKey,
  createAdminUser,
  getAdminApiKey,
  listAdminApiKeys,
  listUsageRecords,
  revealAdminApiKeyToken,
  saveAdminApiKey,
  saveAdminUser,
  type AdminApiKey,
  type AdminUser,
  type UsageRecord,
  type UsageSummary
} from "../admin/store";
import { appendTaskEvent, lastTaskEvent, taskDiagnostics } from "../tasks/events";
import { normalizeStoredObjectKey, publicTaskOutput } from "../tasks/output";
import { getTask, listTasks, saveTask } from "../tasks/store";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import type { AsyncTaskOutputItem, AsyncTaskRecord, Env, ModelConfig } from "../types";
import { createId } from "../utils/ids";
import { readJsonObject, requireString } from "../utils/request";

const DEFAULT_TASK_LIMIT = 50;
const MAX_TASK_LIMIT = 100;
const DEFAULT_STORAGE_TTL_SECONDS = 24 * 60 * 60;

export async function handleAccountRequest(request: Request, env: Env, requestId: string, pathname: string): Promise<Response> {
  if (request.method === "GET" && pathname === "/account/login") {
    if (await isAccountAuthenticated(request, env)) {
      return redirectResponse("/account", requestId);
    }

    return htmlResponse(renderAccountLoginHtml(env), {
      headers: {
        "X-Request-Id": requestId
      }
    });
  }

  if (request.method === "POST" && pathname === "/account/login") {
    return handleAccountLogin(request, env, requestId);
  }

  if (request.method === "POST" && pathname === "/account/logout") {
    return redirectResponse("/account/login", requestId, {
      headers: {
        "Set-Cookie": serializeAccountSessionCookie(request, "", 0)
      }
    });
  }

  if (request.method === "GET" && pathname === "/account") {
    if (!(await isAccountAuthenticated(request, env))) {
      return redirectResponse("/account/login", requestId);
    }

    return htmlResponse(renderAccountAppHtml(env), {
      headers: {
        "X-Request-Id": requestId
      }
    });
  }

  if (!pathname.startsWith("/account/api/")) {
    throw notFound("接口不存在");
  }

  const user = await authenticateAccount(request, env);
  const url = new URL(request.url);

  if (request.method === "GET" && pathname === "/account/api/profile") {
    return handleAccountProfile(user, env, requestId);
  }

  if (request.method === "PATCH" && pathname === "/account/api/profile") {
    return handleUpdateAccountProfile(user, request, env, requestId);
  }

  if (request.method === "GET" && pathname === "/account/api/usage") {
    return handleAccountUsage(user, env, requestId);
  }

  if (request.method === "POST" && pathname === "/account/api/test") {
    return handleAccountTest(user, request, env, requestId);
  }

  if (request.method === "GET" && pathname === "/account/api/tasks") {
    return handleAccountTasks(user, url.searchParams, env, requestId);
  }

  if (request.method === "POST" && pathname === "/account/api/api-keys") {
    return handleCreateAccountApiKey(user, request, env, requestId);
  }

  const apiKeyMatch = pathname.match(/^\/account\/api\/api-keys\/([^/]+)$/);
  if (apiKeyMatch) {
    const apiKeyId = decodeURIComponent(apiKeyMatch[1]);
    if (request.method === "PATCH") {
      return handleUpdateAccountApiKey(user, apiKeyId, request, env, requestId);
    }
    if (request.method === "DELETE") {
      return handleDisableAccountApiKey(user, apiKeyId, env, requestId);
    }
  }

  const apiKeyRevealMatch = pathname.match(/^\/account\/api\/api-keys\/([^/]+)\/reveal$/);
  if (request.method === "POST" && apiKeyRevealMatch) {
    return handleRevealAccountApiKey(user, decodeURIComponent(apiKeyRevealMatch[1]), request, env, requestId);
  }

  const taskDetailMatch = pathname.match(/^\/account\/api\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskDetailMatch) {
    return handleGetAccountTask(user, decodeURIComponent(taskDetailMatch[1]), env, requestId, request.url);
  }

  const taskCancelMatch = pathname.match(/^\/account\/api\/tasks\/([^/]+)\/cancel$/);
  if (request.method === "POST" && taskCancelMatch) {
    return handleCancelAccountTask(user, decodeURIComponent(taskCancelMatch[1]), env, requestId);
  }

  const fileMatch = pathname.match(/^\/account\/api\/files\/(.+)$/);
  if (request.method === "GET" && fileMatch) {
    return handleGetAccountFile(user, fileMatch[1], env, requestId, request.url);
  }

  throw notFound("接口不存在");
}

async function handleAccountLogin(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    const accessToken = String(form.get("access_token") || "");

    if (!email || !email.includes("@")) {
      return renderLoginError(env, "请输入有效邮箱。", requestId, 400);
    }
    if (!(await verifyAccountAccessToken(accessToken, env))) {
      return renderLoginError(env, "用户中心访问口令不正确。", requestId, 401);
    }

    let user = await findAccountUser(env, email);
    if (!user) {
      user = await createAdminUser(env, {
        email,
        role: "member",
        status: "active"
      });
    }
    if (user.status !== "active") {
      return renderLoginError(env, "用户已被禁用。", requestId, 403);
    }

    const session = await createAccountSession(env, user.id);
    return redirectResponse("/account", requestId, {
      headers: {
        "Set-Cookie": serializeAccountSessionCookie(request, session, ACCOUNT_SESSION_TTL_SECONDS)
      }
    });
  } catch (error) {
    return renderLoginError(env, error instanceof Error ? error.message : "登录失败。", requestId, 500);
  }
}

async function handleAccountProfile(user: AdminUser, env: Env, requestId: string): Promise<Response> {
  const [apiKeys, usageRecords, tasks, config] = await Promise.all([
    listUserApiKeys(env, user),
    listUsageRecords(env),
    listTasks(env, MAX_TASK_LIMIT),
    loadGatewayConfig(env)
  ]);
  const userApiKeyIds = new Set(apiKeys.map((apiKey) => apiKey.id));
  const usage = summarizeUsage(usageRecords.filter((record) => record.organization_id === user.organization_id && userApiKeyIds.has(record.api_key_id)));
  const userTasks = tasks.filter((task) => task.organization_id === user.organization_id).slice(0, DEFAULT_TASK_LIMIT);
  const models = listModels(config)
    .filter((model) => model.status !== "disabled")
    .map((model) => ({
      id: model.alias,
      modality: model.modality,
      supports_stream: model.supports_stream !== false,
      supports_async: model.supports_async !== false,
      status: model.status || "active"
    }));

  return jsonResponse(
    {
      user: publicUser(user),
      api_keys: apiKeys.map(publicApiKey),
      usage,
      tasks: userTasks.map(publicTaskSummary),
      models,
      storage: {
        durable: Boolean(env.DB || env.AI_GATEWAY_KV),
        source: env.DB ? "D1" : env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
      }
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpdateAccountProfile(user: AdminUser, request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (body.name !== undefined) {
    user.name = optionalBodyString(body.name, "name");
  }
  user.updated_at = new Date().toISOString();
  await saveAdminUser(env, user);

  return jsonResponse(
    {
      user: publicUser(user)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleAccountUsage(user: AdminUser, env: Env, requestId: string): Promise<Response> {
  const [apiKeys, usageRecords] = await Promise.all([listUserApiKeys(env, user), listUsageRecords(env)]);
  const userApiKeyIds = new Set(apiKeys.map((apiKey) => apiKey.id));
  return jsonResponse(
    {
      usage: summarizeUsage(usageRecords.filter((record) => record.organization_id === user.organization_id && userApiKeyIds.has(record.api_key_id)))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleAccountTasks(user: AdminUser, searchParams: URLSearchParams, env: Env, requestId: string): Promise<Response> {
  const limit = normalizeTaskLimit(searchParams.get("limit"));
  const tasks = (await listTasks(env, MAX_TASK_LIMIT)).filter((task) => task.organization_id === user.organization_id).slice(0, limit);

  return jsonResponse(
    {
      object: "list",
      data: tasks.map(publicTaskSummary)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleCreateAccountApiKey(user: AdminUser, request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const name = requireString(body.name || "默认密钥", "name").trim();
  const allowedModels = normalizeAllowedModels(body.allowed_models);
  const expiresAt = normalizeExpiresAt(body.expires_at);
  const created = await createAdminApiKey(env, {
    organization_id: user.organization_id,
    user_id: user.id,
    name,
    allowed_models: allowedModels,
    expires_at: expiresAt
  });

  return jsonResponse(
    {
      api_key: publicApiKey(created.apiKey),
      secret: created.token,
      warning: "请立即复制保存，密钥明文只会显示一次。"
    },
    {
      status: 201,
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpdateAccountApiKey(
  user: AdminUser,
  apiKeyId: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const apiKey = await requireOwnedApiKey(env, user, apiKeyId);
  const body = await readJsonObject(request);

  if (body.name !== undefined) {
    apiKey.name = requireString(body.name, "name").trim();
  }
  if (body.status !== undefined) {
    apiKey.status = normalizeApiKeyStatus(body.status);
  }
  if (body.allowed_models !== undefined) {
    apiKey.allowed_models = normalizeAllowedModels(body.allowed_models);
  }
  if (body.expires_at !== undefined) {
    apiKey.expires_at = normalizeExpiresAt(body.expires_at);
  }
  apiKey.updated_at = new Date().toISOString();
  await saveAdminApiKey(env, apiKey);

  return jsonResponse(
    {
      api_key: publicApiKey(apiKey)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleDisableAccountApiKey(user: AdminUser, apiKeyId: string, env: Env, requestId: string): Promise<Response> {
  const apiKey = await requireOwnedApiKey(env, user, apiKeyId);
  apiKey.status = "disabled";
  apiKey.updated_at = new Date().toISOString();
  await saveAdminApiKey(env, apiKey);

  return jsonResponse(
    {
      api_key: publicApiKey(apiKey)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleRevealAccountApiKey(
  user: AdminUser,
  apiKeyId: string,
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const apiKey = await requireOwnedApiKey(env, user, apiKeyId);

  const body = await readJsonObject(request);
  const accessToken = requireString(body.access_token, "access_token");

  if (!(await verifyAccountAccessToken(accessToken, env))) {
    throw invalidRequest("访问口令不正确");
  }

  const token = await revealAdminApiKeyToken(env, apiKey);
  if (!token) {
    throw notFound("该密钥创建于旧版本，无法查看明文，请重新创建");
  }

  return jsonResponse(
    {
      api_key_id: apiKey.id,
      token
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleGetAccountTask(
  user: AdminUser,
  taskId: string,
  env: Env,
  requestId: string,
  requestUrl?: string
): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.organization_id !== user.organization_id) {
    throw notFound("任务不存在");
  }

  return jsonResponse(
    { task: publicTaskFull(task, env, requestUrl) },
    {
      headers: { "X-Request-Id": requestId }
    }
  );
}

async function handleCancelAccountTask(user: AdminUser, taskId: string, env: Env, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.organization_id !== user.organization_id) {
    throw notFound("任务不存在");
  }
  if (!isCancelableTask(task)) {
    throw conflict(`任务当前状态不可取消：${task.status}`);
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
    message: "Task canceled from account center"
  });
  await saveTask(env, task);

  return jsonResponse(
    {
      task: publicTaskSummary(task)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleGetAccountFile(
  user: AdminUser,
  rawObjectKey: string,
  env: Env,
  requestId: string,
  requestUrl?: string
): Promise<Response> {
  const objectKey = decodeAccountObjectKey(rawObjectKey, env, requestUrl);
  const taskId = objectKey.match(/^tasks\/([^/]+)\/[^/]+$/)?.[1];
  if (!taskId) {
    throw notFound("文件不存在");
  }

  const task = await getTask(env, taskId);
  if (!task || task.organization_id !== user.organization_id || !taskReferencesAccountObjectKey(task, objectKey, env, requestUrl)) {
    throw notFound("文件不存在");
  }
  if (!env.FILES) {
    throw notFound("文件不存在");
  }

  const object = await env.FILES.get(objectKey);
  if (!object) {
    throw notFound("文件不存在");
  }

  const headers = new Headers({
    "Cache-Control": "private, max-age=300",
    "X-Request-Id": requestId
  });
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
}

function decodeAccountObjectKey(value: string, env: Env, requestUrl?: string): string {
  try {
    const objectKey = normalizeStoredObjectKey(decodeURIComponent(value), env, requestUrl);
    if (objectKey) {
      return objectKey;
    }
  } catch {
    // Fall through to the generic 404 below.
  }
  throw notFound("文件不存在");
}

async function handleAccountTest(user: AdminUser, request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const modelName = requireString(body.model, "model");

  const config = await loadGatewayConfig(env);
  const model = findModel(config, modelName);
  if (!model) {
    throw invalidRequest(`Unknown model: ${modelName}`, "model", "model_not_found");
  }

  if (model.modality !== "text") {
    return handleAccountAsyncTest(user, body, modelName, model, env, requestId);
  }

  const mode = typeof body.mode === "string" ? body.mode : "sync";
  if (mode !== "sync" && mode !== "stream") {
    throw invalidRequest("mode must be sync or stream", "mode");
  }
  const prompt = requireString(body.prompt, "prompt");
  const temperature = body.temperature || 0.7;
  const maxTokens = body.max_tokens || 1000;

  if (mode === "stream" && model.supports_stream === false) {
    throw invalidRequest(`Model does not support stream: ${modelName}`, "mode");
  }

  const route = selectRoute(model, mode === "stream");
  if (!route) {
    throw invalidRequest(`No active provider route for model: ${modelName}`);
  }

  const registry = createProviderRegistry(env);
  const plugin = registry.get(route.plugin_id);
  const adapter = plugin.createAdapter(env);
  if (!adapter.chatCompletions) {
    throw invalidRequest(`Provider plugin does not support chat completions: ${route.plugin_id}`);
  }

  const credential = resolveProviderCredential(env, route);
  
  const chatRequest = {
    model: modelName,
    messages: [{ role: "user", content: prompt }],
    temperature: temperature,
    max_tokens: maxTokens,
    stream: mode === "stream"
  };

  const startTime = Date.now();
  const response = await adapter.chatCompletions(chatRequest as any, {
    env,
    request_id: requestId,
    route,
    credential,
    signal: request.signal
  });

  // For stream mode, we need to collect the streamed data
  if (mode === "stream") {
    const chunks = [];
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    
    return jsonResponse(
      {
        mode: "stream",
        model: modelName,
        duration_ms: Date.now() - startTime,
        content: chunks.join("")
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  } else {
    // For sync mode, parse the JSON response
    const data = await response.json();
    return jsonResponse(
      {
        mode: "sync",
        model: modelName,
        duration_ms: Date.now() - startTime,
        response: data
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  }
}

async function handleAccountAsyncTest(
  user: AdminUser,
  body: Record<string, unknown>,
  modelName: string,
  model: ModelConfig,
  env: Env,
  requestId: string
): Promise<Response> {
  const route = selectRoute(model, false);
  if (!route) {
    throw invalidRequest(`No active provider route for model: ${modelName}`);
  }

  const input = normalizeTestTaskInput(body.input);
  const prompt = requireString(body.prompt ?? input.prompt, "prompt");
  const taskInput: Record<string, unknown> = {
    ...input,
    prompt
  };
  const now = new Date().toISOString();
  const task: AsyncTaskRecord = {
    id: createId("task"),
    object: "task",
    organization_id: user.organization_id,
    api_key_id: `account:${user.id}`,
    type: taskTypeForModality(model.modality),
    model: modelName,
    upstream_id: route.upstream_id,
    plugin_id: route.plugin_id,
    provider_context: {
      upstream_model: route.provider_model,
      request_id: requestId,
      base_url: route.base_url,
      credential_id: route.credential_id,
      config: route.config,
      source: "account_test"
    },
    status: "queued",
    input: taskInput,
    store_output: body.store_output === true,
    storage_ttl_seconds: normalizeTestStorageTtl(body.storage_ttl_seconds),
    output_expires_at: null,
    metadata: {
      source: "account_test",
      user_id: user.id
    },
    created_at: now,
    updated_at: now
  };

  appendTaskEvent(task, {
    stage: "task.created",
    status: task.status,
    request_id: requestId,
    message: "Task created via account center test"
  });

  await saveTask(env, task);
  await enqueueAccountTestTask(env, task);

  return jsonResponse(
    {
      mode: "async_task",
      model: modelName,
      modality: model.modality,
      task: publicTaskSummary(task),
      input: taskInput
    },
    {
      status: 202,
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function enqueueAccountTestTask(env: Env, task: AsyncTaskRecord): Promise<void> {
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
      error: accountErrorMessage(err)
    });
    task.updated_at = new Date().toISOString();
    await saveTask(env, task);
    throw err;
  }
}

function normalizeTestTaskInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("input 必须是 JSON 对象", "input");
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeTestStorageTtl(value: unknown): number {
  if (value === undefined || value === null || value === "") {
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

function taskTypeForModality(modality: ModelConfig["modality"]): string {
  if (modality === "image") return "image";
  if (modality === "video") return "video";
  if (modality === "file") return "file";
  return "chat";
}

function accountErrorMessage(err: unknown): string {
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

async function listUserApiKeys(env: Env, user: AdminUser): Promise<AdminApiKey[]> {
  return (await listAdminApiKeys(env))
    .filter((apiKey) => apiKey.user_id === user.id && apiKey.organization_id === user.organization_id)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

async function requireOwnedApiKey(env: Env, user: AdminUser, apiKeyId: string): Promise<AdminApiKey> {
  const apiKey = await getAdminApiKey(env, apiKeyId);
  if (!apiKey || apiKey.user_id !== user.id || apiKey.organization_id !== user.organization_id) {
    throw notFound("接口密钥不存在");
  }
  return apiKey;
}

async function isAccountAuthenticated(request: Request, env: Env): Promise<boolean> {
  try {
    await authenticateAccount(request, env);
    return true;
  } catch {
    return false;
  }
}

function publicUser(user: AdminUser): Record<string, unknown> {
  return {
    id: user.id,
    organization_id: user.organization_id,
    email: user.email,
    name: user.name || null,
    role: user.role,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

function publicApiKey(apiKey: AdminApiKey): Record<string, unknown> {
  return {
    id: apiKey.id,
    organization_id: apiKey.organization_id,
    user_id: apiKey.user_id,
    name: apiKey.name,
    key_prefix: apiKey.key_prefix,
    allowed_models: apiKey.allowed_models || [],
    status: apiKey.status,
    expires_at: apiKey.expires_at || null,
    created_at: apiKey.created_at,
    updated_at: apiKey.updated_at,
    last_used_at: apiKey.last_used_at || null
  };
}

function publicTaskSummary(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    model: task.model,
    status: task.status,
    upstream_id: task.upstream_id || null,
    plugin_id: task.plugin_id || null,
    provider_task_id: task.provider_task_id || null,
    cancelable: isCancelableTask(task),
    store_output: task.store_output,
    diagnostics: taskDiagnostics(task),
    last_event: lastTaskEvent(task),
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at || null,
    error: task.error || null
  };
}

function publicTaskFull(task: AsyncTaskRecord, env: Env, requestUrl?: string): Record<string, unknown> {
  return {
    id: task.id,
    object: task.object,
    type: task.type,
    model: task.model,
    status: task.status,
    upstream_id: task.upstream_id || null,
    plugin_id: task.plugin_id || null,
    provider_execution_mode: task.provider_execution_mode || null,
    provider_task_id: task.provider_task_id || null,
    input: task.input,
    output: publicAccountTaskOutput(task.output, env, requestUrl) || null,
    store_output: task.store_output,
    storage_ttl_seconds: task.storage_ttl_seconds,
    output_expires_at: task.output_expires_at || null,
    callback_url: task.callback_url || null,
    metadata: task.metadata || null,
    error: task.error || null,
    diagnostics: taskDiagnostics(task),
    events: task.events || [],
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at || null
  };
}

function publicAccountTaskOutput(
  output: AsyncTaskOutputItem[] | undefined,
  env: Env,
  requestUrl?: string
): AsyncTaskOutputItem[] | undefined {
  const items = publicTaskOutput(output, env, requestUrl);
  if (!items) {
    return items;
  }

  return items.map((item) => {
    if ((item.source !== "r2" && item.stored !== true) || typeof item.url !== "string") {
      return item;
    }

    const objectKey = normalizeStoredObjectKey(item.url, env, requestUrl);
    if (!objectKey) {
      return item;
    }

    return {
      ...item,
      url: buildAccountFileUrl(objectKey, requestUrl)
    };
  });
}

function buildAccountFileUrl(objectKey: string, requestUrl?: string): string {
  const path = `/account/api/files/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  if (!requestUrl) {
    return path;
  }
  try {
    return `${new URL(requestUrl).origin}${path}`;
  } catch {
    return path;
  }
}

function taskReferencesAccountObjectKey(task: AsyncTaskRecord, objectKey: string, env: Env, requestUrl?: string): boolean {
  return (task.output || []).some((item) => {
    if ((item.source !== "r2" && item.stored !== true) || typeof item.url !== "string") {
      return false;
    }
    return normalizeStoredObjectKey(item.url, env, requestUrl) === objectKey;
  });
}

function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const sortedRecords = records.sort((left, right) => right.created_at.localeCompare(left.created_at));
  const byModel = new Map<string, UsageSummary["by_model"][number]>();
  const summary: UsageSummary = {
    total_requests: sortedRecords.length,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    media_count: 0,
    cost: 0,
    by_model: [],
    recent: sortedRecords.slice(0, 50)
  };

  for (const record of sortedRecords) {
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

function normalizeAllowedModels(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest("allowed_models 必须是字符串数组", "allowed_models");
  }

  const models = value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw invalidRequest("allowed_models 必须是字符串数组", "allowed_models");
    }
    return item.trim();
  });
  return models.length > 0 ? [...new Set(models)] : undefined;
}

function normalizeExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw invalidRequest("expires_at 必须是字符串", "expires_at");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidRequest("expires_at 必须是有效日期", "expires_at");
  }
  return date.toISOString();
}

function normalizeApiKeyStatus(value: unknown): "active" | "disabled" {
  if (value === "active" || value === "disabled") {
    return value;
  }
  throw invalidRequest("接口密钥状态无效", "status");
}

function optionalBodyString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidRequest(`${name} 必须是字符串`, name);
  }
  return value.trim();
}

function normalizeTaskLimit(value: string | null): number {
  if (!value) {
    return DEFAULT_TASK_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TASK_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_TASK_LIMIT);
}

function isCancelableTask(task: AsyncTaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function redirectResponse(location: string, requestId: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Location", location);
  headers.set("X-Request-Id", requestId);

  return new Response(null, {
    ...init,
    status: init.status || 302,
    headers
  });
}

export function serializeAccountSessionCookie(request: Request, value: string, maxAge: number): string {
  const attributes = [
    `${ACCOUNT_SESSION_COOKIE}=${value}`,
    "Path=/account",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (maxAge === 0) {
    attributes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (new URL(request.url).protocol === "https:") {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function renderLoginError(env: Env, message: string, requestId: string, status: number): Response {
  return htmlResponse(renderAccountLoginHtml(env, message), {
    status,
    headers: {
      "X-Request-Id": requestId
    }
  });
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");

  return new Response(html, {
    ...init,
    headers
  });
}

function renderAccountLoginHtml(env: Env, errorMessage = ""): string {
  const configured = isAccountCenterConfigured(env);
  const errorHtml = errorMessage ? `<div class="alert">${escapeHtml(errorMessage)}</div>` : "";
  const setupHtml = configured
    ? ""
    : '<div class="alert">用户中心未配置访问口令。请先配置 USER_CENTER_TOKEN。</div>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 Teaven AI 用户中心</title>
  <style>
    :root { color-scheme: dark; --bg: #09090b; --panel: #12121a; --line: #2f3142; --text: #fafafa; --muted: #a1a1aa; --accent: #a7f3d0; --accent-strong: #34d399; --danger: #fb7185; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 22px; color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 14% 20%, rgba(52, 211, 153, 0.24), transparent 26rem), radial-gradient(circle at 90% 80%, rgba(14, 165, 233, 0.14), transparent 24rem), linear-gradient(135deg, #09090b, #111827); }
    .shell { width: min(100%, 460px); }
    .card { border: 1px solid rgba(167, 243, 208, 0.18); border-radius: 30px; padding: 30px; background: rgba(18, 18, 26, 0.88); box-shadow: 0 30px 90px rgba(0, 0, 0, 0.36); backdrop-filter: blur(18px); }
    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase; }
    h1 { margin: 10px 0 0; font-size: clamp(36px, 9vw, 64px); letter-spacing: -0.07em; line-height: 0.92; }
    p { margin: 14px 0 0; color: var(--muted); line-height: 1.7; }
    form { display: grid; gap: 12px; margin-top: 26px; }
    label { color: var(--muted); font-size: 13px; font-weight: 800; }
    input, button { width: 100%; font: inherit; }
    input { color: var(--text); background: #0b1020; border: 1px solid var(--line); border-radius: 16px; outline: none; padding: 13px 14px; }
    input:focus { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.13); }
    button { border: 0; border-radius: 999px; color: #052e1d; background: var(--accent); cursor: pointer; font-weight: 900; padding: 13px 16px; }
    button:disabled { opacity: 0.52; cursor: not-allowed; }
    .alert { margin-top: 16px; border: 1px solid rgba(251, 113, 133, 0.35); border-radius: 16px; background: rgba(251, 113, 133, 0.1); color: #fecdd3; padding: 12px 14px; font-size: 13px; }
  </style>
</head>
<body>
  <main class="shell">
    <section class="card">
      <div class="eyebrow">Teaven AI Gateway</div>
      <h1>用户中心</h1>
      <p>使用邮箱和用户中心访问口令登录。首次登录会自动创建账户，然后你可以自助创建 API Key、查看用量和任务。</p>
      ${setupHtml}
      ${errorHtml}
      <form action="/account/login" method="post">
        <label for="email">邮箱</label>
        <input id="email" name="email" type="email" autocomplete="email" required autofocus>
        <label for="access_token">访问口令</label>
        <input id="access_token" name="access_token" type="password" autocomplete="current-password" required>
        <button type="submit" ${configured ? "" : "disabled"}>进入用户中心</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderAccountAppHtml(env: Env): string {
  const origin = env.API_ORIGIN || '';
  return String.raw`<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teaven AI 用户中心</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(15, 23, 42, 0.9);
      --panel-strong: #111827;
      --line: #26364f;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #7dd3fc;
      --accent-strong: #38bdf8;
      --accent-soft: rgba(125, 211, 252, 0.13);
      --ok: #86efac;
      --warn: #fbbf24;
      --danger: #fb7185;
      --shadow: rgba(0, 0, 0, 0.28);
    }

    html[data-theme="light"] {
      color-scheme: light;
      --bg: #f4f7fb;
      --panel: rgba(255, 255, 255, 0.92);
      --panel-strong: #ffffff;
      --line: #d9e2ef;
      --text: #0f172a;
      --muted: #64748b;
      --accent: #0369a1;
      --accent-strong: #0284c7;
      --accent-soft: rgba(3, 105, 161, 0.13);
      --ok: #15803d;
      --warn: #a16207;
      --danger: #be123c;
      --shadow: rgba(15, 23, 42, 0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(56, 189, 248, 0.18), transparent 30rem),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    button {
      border: 0;
      border-radius: 999px;
      background: var(--accent);
      color: #06111f;
      cursor: pointer;
      font-weight: 800;
      padding: 10px 14px;
      transition: transform 150ms ease, background 150ms ease;
    }
    button:hover {
      background: var(--accent-strong);
      transform: translateY(-1px);
    }
    button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: rgba(251, 113, 133, 0.16); color: var(--danger); border: 1px solid rgba(251, 113, 133, 0.35); }
    button.compact { padding: 6px 10px; font-size: 12px; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    input, select, textarea {
      width: 100%;
      color: var(--text);
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 12px;
      outline: none;
      padding: 10px 12px;
    }
    textarea { resize: vertical; min-height: 86px; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12); }

    .layout { display: grid; grid-template-columns: 270px 1fr; min-height: 100vh; }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 16px;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-right: 1px solid var(--line);
      backdrop-filter: blur(18px);
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .brand { padding: 6px 8px 14px; border-bottom: 1px solid var(--line); }
    .eyebrow { color: var(--accent); font-size: 11px; font-weight: 900; letter-spacing: 0.22em; text-transform: uppercase; }
    .brand h1 { margin: 8px 0 0; font-size: 24px; letter-spacing: -0.04em; }
    .nav { display: grid; gap: 7px; }
    .nav a {
      color: var(--muted);
      text-decoration: none;
      padding: 11px 12px;
      border-radius: 14px;
      font-weight: 800;
    }
    .nav a.active, .nav a:hover { color: var(--text); background: var(--accent-soft); }
    .sidebar-footer { margin-top: auto; display: grid; gap: 10px; }
    .content { padding: 28px; min-width: 0; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; margin-bottom: 22px; }
    .topbar h2 { margin: 0; font-size: clamp(30px, 5vw, 54px); letter-spacing: -0.06em; line-height: 0.95; }
    .subtitle { color: var(--muted); margin: 10px 0 0; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }

    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 20px 70px var(--shadow);
      backdrop-filter: blur(18px);
    }
    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-6 { grid-column: span 6; }
    .span-4 { grid-column: span 4; }
    .card h3 { margin: 0 0 12px; font-size: 17px; }
    .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
    .card-head h3 { margin-bottom: 6px; }
    .copy-docs-btn { font-size: 13px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s; }
    .copy-docs-btn:hover { border-color: var(--accent); color: var(--accent); }
    .copy-docs-btn.copied { border-color: var(--success); color: var(--success); }
    .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .stat { padding: 15px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; }
    .stat strong { display: block; font-size: 28px; letter-spacing: -0.04em; }
    .stat span, label { color: var(--muted); font-size: 12px; font-weight: 800; }

    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .form-grid label { display: grid; gap: 6px; }
    .full { grid-column: 1 / -1; }
    .stack { display: grid; gap: 10px; }
    .list { display: grid; gap: 10px; }
    .item {
      display: grid;
      gap: 12px;
      min-width: 0;
      padding: 16px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 18px;
    }
    .item:hover { border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); }
    .item header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .entity-title { min-width: 0; }
    .entity-title strong { display: block; font-size: 16px; line-height: 1.3; word-break: break-word; }
    .entity-title code { word-break: break-all; }
    .entity-meta { display: grid; gap: 8px; }
    .entity-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; }
    .entity-row > span:first-child { color: var(--muted); font-size: 12px; font-weight: 900; }
    .entity-row code { word-break: break-all; }
    .entity-actions { padding-top: 2px; }
    .section { display: none; }
    .section.active { display: block; }

    .badge { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); font-size: 12px; margin: 2px 4px 2px 0; }
    .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: rgba(134, 239, 172, 0.1); }
    .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: rgba(251, 191, 36, 0.1); }
    .badge.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: rgba(251, 113, 133, 0.1); }
    .badge.active { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: rgba(134, 239, 172, 0.1); }
    .badge.disabled { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: rgba(251, 113, 133, 0.1); }
    .badge.queued, .badge.running { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: rgba(251, 191, 36, 0.1); }
    .badge.failed { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: rgba(251, 113, 133, 0.1); }

    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 8px; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    code, pre { font-family: Consolas, "SFMono-Regular", monospace; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    code { color: var(--accent); }
    .table-scroll { overflow-x: auto; }
    .task-table { min-width: 720px; table-layout: fixed; }
    .task-table.summary { min-width: 620px; }
    .task-table code { word-break: break-all; }
    .task-events-scroll { margin-top: 4px; max-height: 240px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; }
    .task-events-table { margin: 0; min-width: 760px; table-layout: fixed; }
    .task-events-table td { word-break: break-word; }
    .time-cell { white-space: nowrap; }

    .secret { display: none; margin-top: 12px; border: 1px solid rgba(125, 211, 252, 0.38); border-radius: 18px; background: rgba(125, 211, 252, 0.1); padding: 14px; }
    .notice { color: var(--muted); border: 1px dashed var(--line); border-radius: 18px; padding: 14px; background: rgba(148, 163, 184, 0.06); }
    .test-preview { display: grid; gap: 12px; }
    .test-task-card { border: 1px solid var(--line); border-radius: 16px; background: var(--panel-strong); padding: 14px; }
    .test-task-card header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
    .image-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .image-preview-card { overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--panel-strong); }
    .image-preview-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: rgba(148, 163, 184, 0.08); }
    .image-preview-card footer { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 10px 12px; font-size: 12px; }
    .image-preview-card a { color: var(--accent); font-weight: 800; text-decoration: none; }
    .doc-block { display: grid; gap: 12px; }
    .doc-block p { margin: 0; color: var(--muted); line-height: 1.7; }
    .doc-list { margin: 0; padding-left: 18px; color: var(--muted); line-height: 1.8; }
    .code-card { overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--panel-strong); padding: 14px; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; font-weight: 600; cursor: pointer; }
    .checkbox-label input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; margin: 0; }
    .key-features { margin-top: 4px; }
    .key-features .badge { font-size: 11px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .image-param-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .image-param-grid .wide { grid-column: span 2; }
    .test-preview { display: grid; gap: 12px; }
    .test-preview-card { border: 1px solid var(--line); border-radius: 16px; background: rgba(125, 211, 252, 0.08); padding: 12px; }
    .image-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .image-preview-card { overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--panel-strong); }
    .image-preview-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: rgba(148, 163, 184, 0.08); }
    .image-preview-card footer { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 10px; font-size: 12px; color: var(--muted); }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 22px;
    }
    .modal.open { display: flex; }
    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(2, 6, 23, 0.72);
      backdrop-filter: blur(10px);
    }
    .modal-card {
      position: relative;
      width: min(1120px, 100%);
      max-height: calc(100vh - 44px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 26px 90px rgba(0, 0, 0, 0.42);
      padding: 18px;
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .modal-head h3 { margin: 4px 0 0; font-size: 20px; }
    .modal-body { display: grid; gap: 12px; }
    .key-modal-card { width: min(680px, 100%); }
    body.modal-open { overflow: hidden; }

    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
      .content { padding: 18px; }
      .topbar { display: grid; }
      .toolbar { justify-content: flex-start; }
      .stat-grid, .form-grid { grid-template-columns: 1fr; }
      .image-param-grid { grid-template-columns: 1fr; }
      .image-param-grid .wide { grid-column: span 1; }
      .card-head { display: grid; }
      .card-head button { width: 100%; }
      .entity-row { grid-template-columns: 1fr; gap: 4px; }
      .span-4, .span-6, .span-8, .span-12 { grid-column: span 12; }
      .modal { padding: 12px; }
      .modal-card { max-height: calc(100vh - 24px); padding: 14px; }
      .modal-head { display: grid; }
      .modal-head button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="eyebrow">Teaven AI Gateway</div>
        <h1>用户中心</h1>
        <p class="subtitle" id="subtitle">正在载入账户信息...</p>
      </div>
      <nav class="nav" id="nav">
         <a href="#dashboard" data-section="dashboard">仪表盘</a>
         <a href="#profile" data-section="profile">个人资料</a>
         <a href="#api-keys" data-section="api-keys">API Key</a>
         <a href="#models" data-section="models">可用模型</a>
         <a href="#test" data-section="test">测试体验</a>
         <a href="#api-docs" data-section="api-docs">接口文档</a>
         <a href="#usage" data-section="usage">用量统计</a>
         <a href="#tasks" data-section="tasks">任务管理</a>
       </nav>
      <div class="sidebar-footer">
        <button id="theme-toggle" class="secondary" type="button">切换浅色</button>
        <form action="/account/logout" method="post"><button class="secondary" type="submit" style="width: 100%;">退出登录</button></form>
      </div>
    </aside>
    <main class="content">
      <div class="topbar">
        <div>
          <h2 id="page-title">仪表盘</h2>
          <p id="status" class="subtitle"></p>
        </div>
        <div class="toolbar">
          <button id="refresh" class="secondary" type="button">刷新</button>
        </div>
      </div>

      <section id="dashboard" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="stat-grid">
              <div class="stat"><span>API Key</span><strong id="statKeys">0</strong></div>
              <div class="stat"><span>请求数</span><strong id="statRequests">0</strong></div>
              <div class="stat"><span>Token</span><strong id="statTokens">0</strong></div>
              <div class="stat"><span>任务</span><strong id="statTasks">0</strong></div>
            </div>
          </div>

          <div class="card span-6">
            <div class="card-head"><h3>用量概览</h3></div>
            <div id="usageTable"></div>
          </div>

          <div class="card span-6">
            <div class="card-head"><h3>最近任务</h3></div>
            <div id="taskTable"></div>
          </div>
        </div>
      </section>

      <section id="profile" class="section">
        <div class="grid">
          <div class="card span-6">
            <div class="card-head"><h3>个人资料</h3></div>
            <form id="profileForm" class="form-grid">
              <label class="full">显示名称<input id="profileName" name="name" placeholder="可选"></label>
              <div class="full" id="profileMeta"></div>
              <button class="full" type="submit">保存资料</button>
            </form>
          </div>
        </div>
      </section>

      <section id="api-keys" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head">
              <div>
                <h3>我的 API Key</h3>
                <p class="subtitle">创建、查看和禁用用于调用 /v1 接口的密钥。</p>
              </div>
              <button id="openKeyModal" type="button">新建 API Key</button>
            </div>
            <div id="keyList" class="list"></div>
          </div>
        </div>
      </section>

      <section id="models" class="section">
         <div class="grid">
           <div class="card span-8">
             <div class="card-head"><h3>可用模型</h3></div>
             <div id="modelList" class="list"></div>
           </div>
         </div>
       </section>

       <section id="test" class="section">
         <div class="grid">
           <div class="card span-12">
              <div class="card-head"><h3>模型测试</h3><p class="subtitle">文本直接返回，图片、视频、文件会创建异步任务，执行需对应 Provider 支持</p></div>
              <form id="testForm" class="form-grid">
                <label class="full">模型<select id="testModel" name="model" required></select></label>
                <div class="full row" id="testModelMeta"></div>
                <label class="full" id="testModeLabel">请求模式<select id="testMode" name="mode">
                  <option value="sync">同步</option>
                  <option value="stream">流式 (仅文本)</option>
                  <option value="task">异步任务</option>
                </select></label>
                
                <label class="full" id="testPromptLabel"><span id="testPromptTitle">提示词</span><textarea id="testPrompt" name="prompt" rows="4" placeholder="输入你的提示词或问题..." required></textarea></label>
                <label class="full" id="testInputJsonLabel" style="display:none;">输入参数 JSON<textarea id="testInputJson" rows="6" spellcheck="false" placeholder="{}"></textarea></label>
                <div class="full" id="testTaskOptions" style="display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:end;">
                  <label class="checkbox-label"><input id="testStoreOutput" type="checkbox" checked><span>转存输出文件</span></label>
                  <label>存储 TTL 秒<input id="testStorageTtl" type="number" min="1" max="86400" step="1" value="86400"></label>
                </div>
                
                <label class="full checkbox-label" id="testAdvancedLabel"><input id="testAdvanced" type="checkbox"><span>高级参数</span></label>
                
                <div class="full" id="advancedParams" style="display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:end;">
                 <label>温度 (Temperature)<input id="testTemperature" type="number" min="0" max="2" step="0.1" value="0.7" placeholder="0-2"></label>
                 <label>最大 Token<input id="testMaxTokens" type="number" min="1" step="1" value="1000" placeholder="最大生成 token 数"></label>
               </div>
               
               <button class="full" type="submit" id="testSubmit">发送测试</button>
             </form>
           </div>

           <div class="card span-12">
             <div class="card-head"><h3>测试结果</h3></div>
              <div id="testResult" class="stack" style="display:none;">
                <div style="font-size:12px;color:var(--muted);">
                  <div><span style="font-weight:bold;">状态:</span> <span id="testStatus"></span></div>
                  <div><span style="font-weight:bold;">耗时:</span> <span id="testDuration">-</span>ms</div>
                </div>
                <div id="testPreview" class="test-preview"></div>
                <div style="border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);padding:12px;overflow:auto;max-height:400px;font-family:Consolas,'SFMono-Regular',monospace;font-size:13px;line-height:1.5;">
                  <pre id="testOutput" style="margin:0;white-space:pre-wrap;word-break:break-word;"></pre>
                </div>
             </div>
             <div id="testEmpty" class="notice">执行测试后将显示结果</div>
           </div>
         </div>
       </section>

      <section id="api-docs" class="section">
        <div class="grid">
          <div class="card span-12 doc-block">
            <div class="card-head"><h3>异步媒体、文件接口</h3><button id="copyApiDocs" type="button" class="copy-docs-btn" title="将下方所有接口文档复制为 Markdown">复制为 Markdown</button></div>
            <p>图片、视频、文件等非文本能力统一使用异步任务接口。创建任务会立即返回 <code>queued</code> 状态，后续通过任务查询接口轮询结果；如传入 <code>callback_url</code>，后台完成后可向该地址投递任务结果。图片模型建议优先使用平台标准参数，平台会按当前模型绑定的 Provider 自动转换为上游参数。</p>
            <div id="mediaModelDocs"></div>
          </div>

          <div class="card span-6 doc-block">
            <h3>鉴权</h3>
            <p>使用用户中心创建的 API Key 调用 <code>/v1</code> 接口。</p>
            <div class="code-card"><pre><code>Authorization: Bearer YOUR_API_KEY
Content-Type: application/json</code></pre></div>
            <p>重复提交保护可选传入 <code>Idempotency-Key</code> 请求头。</p>
          </div>

          <div class="card span-6 doc-block">
            <h3>任务状态</h3>
            <ul class="doc-list">
              <li><code>queued</code>：已入队，等待后台执行。</li>
              <li><code>running</code>：执行中。</li>
              <li><code>succeeded</code>：成功，查看 <code>output</code>。</li>
              <li><code>failed</code>：失败，查看 <code>error</code>。</li>
              <li><code>canceled</code> / <code>expired</code>：已取消或已过期。</li>
            </ul>
          </div>

          <div class="card span-12 doc-block">
            <div class="card-head"><h3>模型列表</h3></div>
            <p>获取当前 API Key 可访问的模型列表。返回每条模型的 <code>id</code>、<code>modality</code>（分类）、<code>price</code>（价格）、<code>price_unit</code>（计费单位）。支持按分类筛选：<code>text</code>（文本）、<code>image</code>（图片）、<code>video</code>（视频）、<code>file</code>（文件）。不传 <code>modality</code> 则返回全部模型。价格为 <code>null</code> 表示模型未设定价格。</p>
            <div class="code-card"><pre><code id="listModelsExample"></code></pre></div>
            <table>
              <thead><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td><code>modality</code></td><td>string</td><td>否</td><td>筛选模型分类：<code>text</code>、<code>image</code>、<code>video</code>、<code>file</code>。</td></tr>
              </tbody>
            </table>
            <p style="margin-top:12px"><strong>响应字段：</strong></p>
            <table>
              <thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td><code>id</code></td><td>string</td><td>模型别名，用于调用时传入 <code>model</code> 参数。</td></tr>
                <tr><td><code>object</code></td><td>string</td><td>固定为 <code>model</code>。</td></tr>
                <tr><td><code>owned_by</code></td><td>string</td><td>固定为 <code>teaven</code>。</td></tr>
                <tr><td><code>modality</code></td><td>string</td><td>模型分类：<code>text</code>、<code>image</code>、<code>video</code>、<code>file</code>。</td></tr>
                <tr><td><code>price</code></td><td>string | null</td><td>价格数值，未设定时为 <code>null</code>。</td></tr>
                <tr><td><code>price_unit</code></td><td>string | null</td><td>计费单位：<code>per_1m_tokens</code>（每百万 Token）或 <code>per_call</code>（每次调用），未设定时为 <code>null</code>。</td></tr>
              </tbody>
            </table>
          </div>

          <div class="card span-12 doc-block">
            <h3>创建生图任务</h3>
            <div class="code-card"><pre><code id="imageTaskExample"></code></pre></div>
          </div>

          <div class="card span-12 doc-block">
            <h3>创建视频任务</h3>
            <div class="code-card"><pre><code id="videoTaskExample"></code></pre></div>
          </div>

          <div class="card span-6 doc-block">
            <h3>查询任务</h3>
            <div class="code-card"><pre><code id="getTaskExample"></code></pre></div>
          </div>

          <div class="card span-6 doc-block">
            <h3>取消任务</h3>
            <div class="code-card"><pre><code id="cancelTaskExample"></code></pre></div>
          </div>

          <div class="card span-12 doc-block">
            <h3>创建任务字段</h3>
            <table>
              <thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td><code>type</code></td><td>string</td><td>任务类型，例如 <code>image</code>、<code>video</code>。</td></tr>
                <tr><td><code>model</code></td><td>string</td><td>模型别名，建议从“可用模型”或本页媒体模型列表选择。</td></tr>
                <tr><td><code>input</code></td><td>object</td><td>模型输入。图片模型推荐使用下方平台标准参数；视频、文件参数仍以具体模型和 Provider 支持为准。</td></tr>
                <tr><td><code>store_output</code></td><td>boolean</td><td>是否把结果文件转存到平台存储，默认 <code>false</code>。</td></tr>
                <tr><td><code>storage_ttl_seconds</code></td><td>integer</td><td>平台文件保留时间，默认且最大 <code>86400</code> 秒。</td></tr>
                <tr><td><code>callback_url</code></td><td>string</td><td>可选，任务完成后回调地址。</td></tr>
                <tr><td><code>metadata</code></td><td>object</td><td>可选，自定义业务元数据，会随任务记录返回。</td></tr>
              </tbody>
            </table>
          </div>

          <div class="card span-12 doc-block">
            <h3>图片 input 平台标准参数</h3>
            <p>推荐调用方使用 <code>image_count</code>、<code>steps</code>、<code>guidance_scale</code> 这类平台标准字段。旧字段 <code>n</code>、<code>num_inference_steps</code>、<code>cfg_scale</code> 继续兼容，但新接入建议使用标准字段。</p>
            <table>
              <thead><tr><th>字段</th><th>类型</th><th>默认值</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td><code>prompt</code></td><td>string</td><td>必填</td><td>生图提示词。可放在任务顶层 <code>prompt</code>，也可放在 <code>input.prompt</code>。</td></tr>
                <tr><td><code>size</code></td><td>string</td><td><code>1024x1024</code></td><td>图片尺寸，例如 <code>1024x1024</code>。支持该字段的 Provider 会自动拆成上游需要的尺寸参数。</td></tr>
                <tr><td><code>width</code></td><td>integer</td><td>从 <code>size</code> 推导</td><td>图片宽度。传了 <code>width</code> / <code>height</code> 时优先级高于 <code>size</code>。</td></tr>
                <tr><td><code>height</code></td><td>integer</td><td>从 <code>size</code> 推导</td><td>图片高度。传了 <code>width</code> / <code>height</code> 时优先级高于 <code>size</code>。</td></tr>
                <tr><td><code>image_count</code></td><td>integer</td><td><code>1</code></td><td>生成图片数量。兼容旧字段 <code>n</code>。</td></tr>
                <tr><td><code>steps</code></td><td>integer</td><td><code>30</code></td><td>迭代 / 采样步数。兼容旧字段 <code>num_inference_steps</code>。只有支持该能力的 Provider 才会生效。</td></tr>
                <tr><td><code>guidance_scale</code></td><td>number</td><td><code>1.0</code></td><td>提示词引导强度。兼容旧字段 <code>cfg_scale</code>。只有支持该能力的 Provider 才会生效。</td></tr>
                <tr><td><code>negative_prompt</code></td><td>string</td><td><code>""</code></td><td>反向提示词。只有支持该能力的 Provider 才会生效。</td></tr>
                <tr><td><code>seed</code></td><td>integer</td><td>无</td><td>随机种子，用于尽量复现结果，具体范围由上游决定。</td></tr>
                <tr><td><code>response_format</code></td><td>string</td><td><code>url</code></td><td>图片返回格式，常见值为 <code>url</code> 或 <code>b64_json</code>，具体支持由 Provider 决定。</td></tr>
                <tr><td><code>quality</code></td><td>string</td><td>无</td><td>图片质量，主要用于 OpenAI 兼容类生图模型，取值由上游决定。</td></tr>
                <tr><td><code>style</code></td><td>string</td><td>无</td><td>图片风格，主要用于 OpenAI 兼容类生图模型，取值由上游决定。</td></tr>
                <tr><td><code>provider_params</code></td><td>object</td><td>无</td><td>Provider 原生参数透传区。只有当标准字段不足以表达某个上游私有参数时使用。</td></tr>
              </tbody>
            </table>
          </div>

          <div class="card span-12 doc-block">
            <h3>Provider 参数映射</h3>
            <p>不同上游的原生参数名不一致。平台会优先读取标准字段，再兼容旧字段，最后读取 <code>provider_params</code> 中的原生字段。</p>
            <table>
              <thead><tr><th>平台字段</th><th><code>moark-async</code> 上游字段</th><th><code>openai-compatible</code> 上游字段</th></tr></thead>
              <tbody>
                <tr><td><code>prompt</code></td><td><code>prompt</code></td><td><code>prompt</code></td></tr>
                <tr><td><code>size</code></td><td><code>width</code> + <code>height</code></td><td><code>size</code></td></tr>
                <tr><td><code>width</code> / <code>height</code></td><td><code>width</code> / <code>height</code></td><td><code>size</code>，格式为 <code>{width}x{height}</code></td></tr>
                <tr><td><code>image_count</code> / <code>n</code></td><td><code>num_images_per_prompt</code></td><td><code>n</code></td></tr>
                <tr><td><code>steps</code> / <code>num_inference_steps</code></td><td><code>num_inference_steps</code></td><td>非 OpenAI 标准字段；如上游兼容实现支持，可放入 <code>provider_params</code></td></tr>
                <tr><td><code>guidance_scale</code> / <code>cfg_scale</code></td><td><code>cfg_scale</code></td><td>非 OpenAI 标准字段；如上游兼容实现支持，可放入 <code>provider_params</code></td></tr>
                <tr><td><code>negative_prompt</code></td><td><code>negative_prompt</code></td><td>非 OpenAI 标准字段；如上游兼容实现支持，可放入 <code>provider_params</code></td></tr>
                <tr><td><code>seed</code></td><td><code>seed</code></td><td>非 OpenAI 标准字段；如上游兼容实现支持，可放入 <code>provider_params</code></td></tr>
                <tr><td><code>response_format</code></td><td>当前不映射</td><td><code>response_format</code></td></tr>
                <tr><td><code>quality</code></td><td>当前不映射</td><td><code>quality</code></td></tr>
                <tr><td><code>style</code></td><td>当前不映射</td><td><code>style</code></td></tr>
              </tbody>
            </table>
            <p><code>provider_params</code> 示例：</p>
            <div class="code-card"><pre><code>{
  "provider_params": {
    "lora_weights": ["style_xxx"],
    "custom_option": true
  }
}</code></pre></div>
          </div>
        </div>
      </section>

      <section id="usage" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head"><h3>用量统计</h3></div>
            <div id="usageDetail"></div>
          </div>
        </div>
      </section>

      <section id="tasks" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head"><h3>任务列表</h3></div>
            <div id="taskDetail"></div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div id="key-modal" class="modal" aria-hidden="true">
    <div class="modal-backdrop" data-key-modal-close></div>
    <section class="modal-card key-modal-card" role="dialog" aria-modal="true" aria-labelledby="key-modal-title">
      <div class="modal-head">
        <div>
          <div class="eyebrow">API Key</div>
          <h3 id="key-modal-title">新建 API Key</h3>
        </div>
        <button class="secondary compact" type="button" data-key-modal-close>关闭</button>
      </div>
      <form id="keyForm" class="form-grid">
        <label class="full">名称<input id="keyName" name="name" value="默认密钥" required></label>
        <label class="full" id="expiresLabel" style="opacity:0.45;">过期时间<input id="keyExpires" name="expires_at" type="datetime-local" disabled></label>
        <div class="full row"><label class="checkbox-label"><input id="keyPermanent" type="checkbox" checked><span>永不过期</span></label></div>
        <div class="full row"><label class="checkbox-label"><input id="keyAllModels" type="checkbox" checked><span>不限模型</span></label></div>
        <label class="full" id="modelsLabel" style="opacity:0.45;">指定模型<select id="keyModels" name="allowed_models" multiple size="4" disabled></select></label>
        <div class="full row key-features"><span class="badge ok">用量：不限</span><span class="badge ok" id="expiresBadge">过期：永不</span><span class="badge ok" id="modelsBadge">模型：全部</span></div>
        <button type="submit">创建密钥</button>
      </form>
      <div id="secretBox" class="secret"></div>
    </section>
  </div>

  <div id="task-modal" class="modal" aria-hidden="true">
    <div class="modal-backdrop" data-task-modal-close></div>
    <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
      <div class="modal-head">
        <div>
          <div class="eyebrow">Task Detail</div>
          <h3 id="task-modal-title">任务详情</h3>
        </div>
        <button class="secondary compact" type="button" data-task-modal-close>关闭</button>
      </div>
      <div id="task-modal-body" class="modal-body">
        <div class="notice">选择任务后显示详情。</div>
      </div>
    </section>
  </div>

  <script>window.__APP_ORIGIN__ = ${JSON.stringify(origin)};</script>
  <script>
    let state = null;
    let lastAutoRefreshAt = Date.now();
    let activeTestTaskPoll = null;
    let activeTestTaskId = null;
    const $ = (selector) => document.querySelector(selector);
    const fmt = new Intl.NumberFormat('zh-CN');
    const pageTitles = { dashboard: '仪表盘', profile: '个人资料', 'api-keys': 'API Key', models: '可用模型', test: '测试体验', 'api-docs': '接口文档', usage: '用量统计', tasks: '任务管理' };
    const keyModal = $('#key-modal');
    const taskModal = $('#task-modal');
    const taskModalTitle = $('#task-modal-title');
    const taskModalBody = $('#task-modal-body');

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || '请求失败');
      return data;
    }

    async function load() {
      state = await api('/account/api/profile');
      render();
    }

    function refreshAfterTabSwitch() {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastAutoRefreshAt < 1000) return;
      lastAutoRefreshAt = now;
      $('#status').textContent = '正在自动刷新...';
      load()
        .then(() => { $('#status').textContent = '已自动刷新'; })
        .catch((error) => { $('#status').textContent = error.message || String(error); });
    }

    function render() {
       const user = state.user;
       $('#subtitle').textContent = user.name ? user.name + ' · ' + user.email : user.email;
       $('#status').textContent = '数据已更新';
       $('#profileName').value = user.name || '';
       $('#profileMeta').innerHTML = '<div class="entity-row"><span>用户 ID</span><code>' + escapeHtml(user.id) + '</code></div><div class="entity-row"><span>组织 ID</span><code>' + escapeHtml(user.organization_id) + '</code></div><div class="entity-row"><span>角色</span><span>' + escapeHtml(user.role) + '</span></div><div class="entity-row"><span>存储</span><span>' + escapeHtml(state.storage.source) + '</span></div>';
       $('#statKeys').textContent = fmt.format(state.api_keys.length);
       $('#statRequests').textContent = fmt.format(state.usage.total_requests);
       $('#statTokens').textContent = fmt.format(state.usage.total_tokens);
       $('#statTasks').textContent = fmt.format(state.tasks.length);
       renderModels();
       renderTestModels();
       renderKeys();
       renderUsage();
       renderTasks();
       renderApiDocs();
       renderUsageDetail();
       renderTaskDetail();
     }

     function renderModels() {
        $('#keyModels').innerHTML = state.models.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + ' · ' + escapeHtml(modalityText(model.modality)) + '</option>').join('');
        $('#modelList').innerHTML = state.models.length ? state.models.map((model) => '<div class="item"><header><strong>' + escapeHtml(model.id) + '</strong><span class="badge ok">' + escapeHtml(modalityText(model.modality)) + '</span></header><span class="muted">流式：' + (model.supports_stream ? '支持' : '不支持') + ' · 异步：' + (model.supports_async ? '支持' : '不支持') + '</span></div>').join('') : '<div class="notice">暂无可用模型。</div>';
      }

      function renderTestModels() {
        const models = state.models;
        const currentModel = $('#testModel').value;
        if (models.length === 0) {
          $('#testForm').style.display = 'none';
          $('#testModel').innerHTML = '';
          $('#testEmpty').textContent = '暂无可测试模型。';
          return;
        }
        $('#testForm').style.display = 'block';
        $('#testModel').innerHTML = models.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + ' · ' + escapeHtml(modalityText(model.modality)) + '</option>').join('');
        if (currentModel && models.some((model) => model.id === currentModel)) {
          $('#testModel').value = currentModel;
        }
        $('#testEmpty').textContent = '执行测试后将显示结果';
        updateTestFormForModel();
      }

      function updateTestFormForModel() {
        const model = selectedTestModel();
        if (!model) return;
        const isText = model.modality === 'text';
        const streamOption = $('#testMode').querySelector('option[value="stream"]');
        const taskOption = $('#testMode').querySelector('option[value="task"]');
        if (streamOption) streamOption.disabled = !model.supports_stream;
        if (taskOption) taskOption.disabled = isText;
        $('#testModelMeta').innerHTML = '<span class="badge ok">' + escapeHtml(modalityText(model.modality)) + '</span><span class="badge ' + (isText && model.supports_stream ? 'ok' : '') + '">流式：' + (isText && model.supports_stream ? '支持' : '不适用') + '</span><span class="badge ' + (!isText && model.supports_async ? 'ok' : '') + '">异步：' + (!isText && model.supports_async ? '支持' : (isText ? '不适用' : '未声明')) + '</span>';
        $('#testModeLabel').style.display = isText ? 'block' : 'none';
        $('#testInputJsonLabel').style.display = isText ? 'none' : 'block';
        $('#testTaskOptions').style.display = isText ? 'none' : 'grid';
        $('#testAdvancedLabel').style.display = isText ? 'flex' : 'none';
        $('#advancedParams').style.display = isText && $('#testAdvanced').checked ? 'grid' : 'none';
        $('#testPromptTitle').textContent = isText ? '提示词' : '提示词/任务说明';
        $('#testPrompt').placeholder = isText ? '输入你的提示词或问题...' : testPromptPlaceholder(model.modality);
        if (isText) {
          if ($('#testMode').value === 'task' || ($('#testMode').value === 'stream' && !model.supports_stream)) $('#testMode').value = 'sync';
          return;
        }
        $('#testMode').value = 'task';
        $('#testInputJson').placeholder = testInputPlaceholder(model.modality);
        if (!$('#testInputJson').value.trim()) {
          $('#testInputJson').value = JSON.stringify(defaultTestInput(model.modality), null, 2);
        }
      }

      function selectedTestModel() {
        if (!state) return null;
        const selected = $('#testModel').value;
        return state.models.find((model) => model.id === selected) || state.models[0] || null;
      }

      function modalityText(value) {
        if (value === 'text') return '文本';
        if (value === 'image') return '图片';
        if (value === 'video') return '视频';
        if (value === 'file') return '文件';
        return value || '未知';
      }

      function statusText(status) {
        if (status === 'queued') return '排队中';
        if (status === 'running') return '运行中';
        if (status === 'succeeded') return '成功';
        if (status === 'failed') return '失败';
        if (status === 'canceled') return '已取消';
        if (status === 'expired') return '已过期';
        if (status === 'active') return '启用';
        if (status === 'disabled') return '停用';
        if (status === 'hidden') return '隐藏';
        if (status === 'degraded') return '降级';
        return status;
      }

      function providerStatusText(status) {
        if (!status) return '-';
        const normalized = String(status).trim().toLowerCase().replace(/[\s-]+/g, '_');
        const text = statusText(normalized);
        if (text !== normalized) return text;
        const map = {
          new: '新建',
          created: '已创建',
          accepted: '已接收',
          submitted: '已提交',
          scheduled: '已调度',
          waiting: '等待中',
          wait: '等待中',
          pending_review: '等待审核',
          queue: '排队中',
          queued: '排队中',
          pending: '等待中',
          starting: '启动中',
          started: '已启动',
          init: '初始化中',
          initializing: '初始化中',
          in_progress: '进行中',
          processing: '处理中',
          process: '处理中',
          generating: '生成中',
          rendering: '渲染中',
          uploading: '上传中',
          storing: '存储中',
          delivering: '投递中',
          retry: '重试中',
          retrying: '重试中',
          done: '已完成',
          finished: '已完成',
          finish: '已完成',
          completed: '已完成',
          complete: '已完成',
          success: '成功',
          successful: '成功',
          failure: '失败',
          failed: '失败',
          error: '错误',
          errored: '错误',
          http_error: 'HTTP 错误',
          request_error: '请求错误',
          api_error: '接口错误',
          upstream_error: '上游错误',
          bad_request: '请求参数错误',
          invalid: '无效',
          unauthorized: '未授权',
          forbidden: '禁止访问',
          not_found: '未找到',
          rate_limited: '已限流',
          throttled: '已限流',
          internal_error: '内部错误',
          server_error: '服务端错误',
          service_unavailable: '服务不可用',
          rejected: '已拒绝',
          blocked: '已阻塞',
          denied: '已拒绝',
          cancelled: '已取消',
          canceled: '已取消',
          cancel: '已取消',
          canceling: '取消中',
          cancelling: '取消中',
          timeout: '超时',
          timed_out: '已超时',
          timeouted: '已超时',
          expired: '已过期',
          ok: '正常',
          warning: '警告',
          degraded: '降级'
        };
        return map[normalized] || '未知状态：' + status;
      }

      function stageText(stage) {
        const map = {
          'task.created': '任务创建',
          'queue.enqueued': '任务入队',
          'processor.started': '开始处理',
          'upstream.create.started': '上游创建开始',
          'upstream.create.succeeded': '上游创建成功',
          'upstream.create.failed': '上游创建失败',
          'upstream.create.error': '上游创建错误',
          'upstream.create.completed_sync': '上游同步完成',
          'queue.reenqueued': '重新入队',
          'queue.unavailable': '队列不可用',
          'queue.enqueue_failed': '入队失败',
          'queue.reenqueue_failed': '重新入队失败',
          'poll.started': '轮询开始',
          'poll.result': '轮询结果',
          'poll.error': '轮询错误',
          'task.succeeded': '任务成功',
          'task.failed': '任务失败',
          'task.canceled': '任务取消',
          'task.expired': '任务过期',
          'output.store.started': '输出存储开始',
          'output.store.completed': '输出存储完成',
          'callback.deliver_started': '回调投递开始',
          'callback.delivered': '回调投递成功',
          'callback.delivery_failed': '回调投递失败',
        };
        return map[stage] || stage;
      }

      function testPromptPlaceholder(modality) {
        if (modality === 'image') return '描述你想生成的图片，例如：一只猫坐在云端...';
        if (modality === 'video') return '描述你想生成的视频，例如：海面日出，电影感镜头推进...';
        if (modality === 'file') return '描述文件处理目标，例如：提取要点并生成摘要...';
        return '输入任务说明...';
      }

      function defaultTestInput(modality) {
        if (modality === 'image') return { size: '1024x1024', image_count: 1, steps: 30, guidance_scale: 1, negative_prompt: '', response_format: 'url' };
        if (modality === 'video') return { duration: 5, size: '1280x720', fps: 24 };
        if (modality === 'file') return { file_url: 'https://example.com/input.pdf' };
        return {};
      }

      function testInputPlaceholder(modality) {
        return JSON.stringify(defaultTestInput(modality), null, 2);
      }

      function parseTestInputJson() {
        const raw = $('#testInputJson').value.trim();
        if (!raw) return {};
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new Error('输入参数 JSON 格式不正确');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('输入参数 JSON 必须是对象');
        }
        return parsed;
      }

      function clearTestTaskPoll() {
        if (activeTestTaskPoll) {
          clearTimeout(activeTestTaskPoll);
          activeTestTaskPoll = null;
        }
        activeTestTaskId = null;
      }

      function isTerminalTaskStatus(status) {
        return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'expired';
      }

      function renderTestTaskPreview(task, message) {
        if (!task) {
          $('#testPreview').innerHTML = '';
          return;
        }
        const detail = task.last_event ? translateDiagnosticText(task.last_event.message || task.last_event.stage || '') : '';
        const body = '<div class="test-task-card"><header><div><div class="muted" style="font-size:11px;font-weight:900;">异步任务</div><div><code>' + escapeHtml(task.id) + '</code></div></div><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(statusText(task.status)) + '</span></header>' +
          '<div class="entity-meta"><div class="entity-row"><span>模型</span><span>' + escapeHtml(task.model || '-') + '</span></div><div class="entity-row"><span>类型</span><span>' + escapeHtml(taskTypeText(task.type)) + '</span></div><div class="entity-row"><span>提示</span><span>' + escapeHtml(message || detail || '任务已创建，正在等待结果。') + '</span></div></div>' +
          '<div class="actions" style="margin-top:12px;"><button class="compact" type="button" data-view-task="' + escapeHtml(task.id) + '">查看详情</button>' + (task.cancelable ? '<button class="compact danger" type="button" data-cancel-task="' + escapeHtml(task.id) + '">取消</button>' : '') + '</div></div>';
        $('#testPreview').innerHTML = body + renderTestImagePreview(task);
      }

      function renderTestImagePreview(task) {
        if (task.type !== 'image') return '';
        const output = Array.isArray(task.output) ? task.output : [];
        const images = output.filter((item) => item && (item.url || item.b64_json));
        if (images.length) {
          return '<div class="image-preview-grid">' + images.map((item, index) => {
            const src = imageOutputSrc(item);
            const label = item.stored ? '已转存' : (item.source === 'upstream' ? '上游 URL' : '图片');
            const openLink = item.url ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noreferrer">打开原图</a>' : '<span class="muted">Base64</span>';
            return '<article class="image-preview-card"><img src="' + escapeHtml(src) + '" alt="生成图片 ' + (index + 1) + '" loading="lazy"><footer><span>' + escapeHtml(label) + ' #' + (index + 1) + '</span>' + openLink + '</footer></article>';
          }).join('') + '</div>';
        }
        if (task.status === 'succeeded') return '<div class="notice">任务已成功，但输出中没有可预览的图片 URL 或 Base64 内容。</div>';
        if (task.status === 'failed') return '<div class="notice" style="color:var(--danger);border-color:rgba(251,113,133,0.35);">生图失败，请查看下方 JSON 或任务详情中的错误信息。</div>';
        return '<div class="notice">图片生成中，完成后会在这里自动显示预览。</div>';
      }

      function imageOutputSrc(item) {
        if (item.url) return item.url;
        const value = String(item.b64_json || '');
        return value.startsWith('data:') ? value : 'data:image/png;base64,' + value;
      }

      function taskTypeText(value) {
        if (value === 'image' || value === 'image_generation' || value === 'image.generation' || value === 'image.generations' || value === 'images.generations') return '图片生成';
        if (value === 'video' || value === 'video_generation' || value === 'video.generation' || value === 'video.generations' || value === 'videos.generations') return '视频生成';
        if (value === 'file' || value === 'file.processing') return '文件处理';
        if (value === 'chat' || value === 'chat.completions') return '聊天补全';
        return value || '未知类型';
      }

      async function pollTestTask(taskId, attempt = 0) {
        if (activeTestTaskId !== taskId) return;
        if (attempt >= 60) {
          $('#testStatus').textContent = '等待超时';
          $('#testPreview').insertAdjacentHTML('beforeend', '<div class="notice">自动轮询已停止，可点击“查看详情”或刷新页面继续查看结果。</div>');
          activeTestTaskPoll = null;
          activeTestTaskId = null;
          return;
        }
        try {
          const data = await api('/account/api/tasks/' + encodeURIComponent(taskId));
          if (activeTestTaskId !== taskId) return;
          const task = data.task;
          $('#testStatus').textContent = statusText(task.status);
          $('#testOutput').textContent = JSON.stringify({ mode: 'async_task', task }, null, 2);
          renderTestTaskPreview(task, isTerminalTaskStatus(task.status) ? '任务已结束。' : '正在自动查询任务结果...');
          if (isTerminalTaskStatus(task.status)) {
            activeTestTaskPoll = null;
            activeTestTaskId = null;
            await load();
            return;
          }
          activeTestTaskPoll = setTimeout(() => pollTestTask(taskId, attempt + 1), 2000);
        } catch (error) {
          if (activeTestTaskId !== taskId) return;
          activeTestTaskPoll = null;
          activeTestTaskId = null;
          $('#testPreview').insertAdjacentHTML('beforeend', '<div class="notice" style="color:var(--danger);border-color:rgba(251,113,133,0.35);">轮询任务失败：' + escapeHtml(error.message) + '</div>');
        }
      }

    function renderKeys() {
      $('#keyList').innerHTML = state.api_keys.length ? state.api_keys.map((key) => '<article class="item"><header><div><strong>' + escapeHtml(key.name) + '</strong><div class="muted"><code>' + escapeHtml(key.key_prefix) + '...</code></div></div><span class="badge ' + escapeHtml(key.status) + '">' + escapeHtml(key.status) + '</span></header><div class="entity-meta"><div class="entity-row"><span>模型</span><span>' + escapeHtml(key.allowed_models.length ? key.allowed_models.join(', ') : '全部模型') + '</span></div><div class="entity-row"><span>过期</span><span>' + escapeHtml(key.expires_at ? formatDate(key.expires_at) : '永不过期') + '</span></div><div class="entity-row"><span>最后使用</span><span>' + escapeHtml(key.last_used_at ? formatDate(key.last_used_at) : '尚未使用') + '</span></div></div><div class="actions"><button class="compact" data-reveal-key="' + escapeHtml(key.id) + '">查看密钥</button><button class="compact danger" data-disable-key="' + escapeHtml(key.id) + '" ' + (key.status === 'disabled' ? 'disabled' : '') + '>禁用</button></div><div id="reveal-' + escapeHtml(key.id) + '" class="secret" style="display:none;"></div></article>').join('') : '<div class="notice">还没有 API Key。创建第一个密钥后即可调用 /v1 接口。</div>';
    }

    function renderUsage() {
      const rows = state.usage.by_model.map((row) => '<tr><td>' + escapeHtml(row.model) + '</td><td>' + fmt.format(row.requests) + '</td><td>' + fmt.format(row.total_tokens) + '</td><td>' + fmt.format(row.media_count) + '</td></tr>').join('');
      $('#usageTable').innerHTML = rows ? '<table><thead><tr><th>模型</th><th>请求</th><th>Token</th><th>媒体</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="notice">暂无用量记录。</div>';
    }

    function renderTasks() {
      const rows = state.tasks.map((task) => '<tr id="task-row-' + escapeHtml(task.id) + '"><td><code>' + escapeHtml(task.id) + '</code></td><td>' + escapeHtml(task.model) + '</td><td><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(statusText(task.status)) + '</span></td><td class="time-cell">' + formatDate(task.created_at) + '</td><td class="actions">' + (task.cancelable ? '<button class="compact danger" data-cancel-task="' + escapeHtml(task.id) + '">取消</button>' : '') + '<button class="compact" data-view-task="' + escapeHtml(task.id) + '">查看详情</button></td></tr>').join('');
      const cols = '<colgroup><col style="width:34%"><col style="width:24%"><col style="width:12%"><col style="width:18%"><col style="width:12%"></colgroup>';
      $('#taskTable').innerHTML = rows ? '<div class="table-scroll"><table class="task-table summary">' + cols + '<thead><tr><th>任务</th><th>模型</th><th>状态</th><th>创建</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="notice">暂无任务。</div>';
    }

    function renderApiDocs() {
      const origin = window.__APP_ORIGIN__ || window.location.origin;
      const imageModel = findModelByModality('image') || 'image-basic';
      const videoModel = findModelByModality('video') || 'video-basic';
      const mediaModels = state.models.filter((model) => model.modality === 'image' || model.modality === 'video' || model.modality === 'file');
      const imageBody = JSON.stringify({ type: 'image', model: imageModel, input: { prompt: '一只猫坐在云端', size: '1024x1024', image_count: 1, steps: 30, guidance_scale: 1, negative_prompt: '低清晰度、畸形', seed: 123456, response_format: 'url' }, store_output: true, storage_ttl_seconds: 86400, callback_url: 'https://example.com/webhooks/ai-task', metadata: { biz_id: 'order_123' } }, null, 2);
      const videoBody = JSON.stringify({ type: 'video', model: videoModel, input: { prompt: '海面日出，电影感镜头推进', duration: 5, size: '1280x720', fps: 24 }, store_output: true, storage_ttl_seconds: 86400, metadata: { scene: 'landing-page' } }, null, 2);

      $('#mediaModelDocs').innerHTML = mediaModels.length ? '<table><thead><tr><th>模型</th><th>类型</th><th>异步</th></tr></thead><tbody>' + mediaModels.map((model) => '<tr><td><code>' + escapeHtml(model.id) + '</code></td><td>' + escapeHtml(modalityText(model.modality)) + '</td><td>' + (model.supports_async ? '支持' : '未声明') + '</td></tr>').join('') + '</tbody></table>' : '<div class="notice">当前没有配置图片、视频或文件模型。可先在后台添加非文本模型，再按下方异步任务接口调用。</div>';
      $('#imageTaskExample').textContent = ['POST ' + origin + '/v1/tasks', 'Authorization: Bearer YOUR_API_KEY', 'Content-Type: application/json', 'Idempotency-Key: image-demo-001', '', imageBody].join('\n');
      $('#videoTaskExample').textContent = ['POST ' + origin + '/v1/tasks', 'Authorization: Bearer YOUR_API_KEY', 'Content-Type: application/json', '', videoBody].join('\n');
      $('#getTaskExample').textContent = ['GET ' + origin + '/v1/tasks/task_xxx', 'Authorization: Bearer YOUR_API_KEY'].join('\n');
      $('#cancelTaskExample').textContent = ['POST ' + origin + '/v1/tasks/task_xxx/cancel', 'Authorization: Bearer YOUR_API_KEY'].join('\n');
      $('#listModelsExample').textContent = [
        'GET ' + origin + '/v1/models',
        'Authorization: Bearer YOUR_API_KEY',
        '',
        '# 全部模型（不传 modality）',
        'GET ' + origin + '/v1/models',
        '',
        '# 只返回图片模型',
        'GET ' + origin + '/v1/models?modality=image',
        '',
        '# 响应示例（含 modality、price）：',
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'teaven', modality: 'text', price: '0.15', price_unit: 'per_1m_tokens' },
            { id: 'image-basic', object: 'model', owned_by: 'teaven', modality: 'image', price: '0.02', price_unit: 'per_call' }
          ]
        }, null, 2)
      ].join('\n');
    }

    function findModelByModality(modality) {
      const model = state.models.find((item) => item.modality === modality);
      return model ? model.id : '';
    }

    function renderUsageDetail() {
      const rows = state.usage.by_model.map((row) => '<tr><td>' + escapeHtml(row.model) + '</td><td>' + fmt.format(row.requests) + '</td><td>' + fmt.format(row.prompt_tokens) + '</td><td>' + fmt.format(row.completion_tokens) + '</td><td>' + fmt.format(row.total_tokens) + '</td><td>' + fmt.format(row.media_count) + '</td></tr>').join('');
      const summary = '<div class="stat-grid"><div class="stat"><span>总请求</span><strong>' + fmt.format(state.usage.total_requests) + '</strong></div><div class="stat"><span>总 Token</span><strong>' + fmt.format(state.usage.total_tokens) + '</strong></div><div class="stat"><span>Prompt</span><strong>' + fmt.format(state.usage.prompt_tokens) + '</strong></div><div class="stat"><span>Completion</span><strong>' + fmt.format(state.usage.completion_tokens) + '</strong></div></div>';
      $('#usageDetail').innerHTML = summary + (rows ? '<table><thead><tr><th>模型</th><th>请求</th><th>Prompt</th><th>Completion</th><th>总计</th><th>媒体</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="notice">暂无用量记录。</div>');
    }

    function renderTaskDetail() {
      const rows = state.tasks.map((task) => '<tr id="task-detail-row-' + escapeHtml(task.id) + '"><td><code>' + escapeHtml(task.id) + '</code></td><td>' + escapeHtml(task.type) + '</td><td>' + escapeHtml(task.model) + '</td><td><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(statusText(task.status)) + '</span></td><td class="time-cell">' + formatDate(task.created_at) + '</td><td class="time-cell">' + (task.completed_at ? formatDate(task.completed_at) : '-') + '</td><td class="actions">' + (task.cancelable ? '<button class="compact danger" data-cancel-task="' + escapeHtml(task.id) + '">取消</button>' : '') + '<button class="compact" data-view-task="' + escapeHtml(task.id) + '">查看详情</button></td></tr>').join('');
      const cols = '<colgroup><col style="width:28%"><col style="width:11%"><col style="width:18%"><col style="width:10%"><col style="width:14%"><col style="width:14%"><col style="width:5%"></colgroup>';
      $('#taskDetail').innerHTML = rows ? '<div class="table-scroll"><table class="task-table">' + cols + '<thead><tr><th>任务</th><th>类型</th><th>模型</th><th>状态</th><th>创建</th><th>完成</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="notice">暂无任务。</div>';
    }

    function renderTaskDiagnostics(diagnostics) {
      if (!diagnostics) return '';
      const items = [
        ['轮询次数', diagnostics.poll_count ?? 0],
        ['创建尝试', diagnostics.create_attempt_count ?? 0],
        ['上游状态', providerStatusText(diagnostics.provider_status)],
        ['上游业务码', diagnostics.provider_response_code || '-'],
        ['上游 HTTP', diagnostics.provider_http_status || '-'],
        ['最后轮询', diagnostics.last_poll_at ? formatDate(diagnostics.last_poll_at) : '-'],
        ['下次轮询', diagnostics.next_poll_at ? formatDate(diagnostics.next_poll_at) : '-'],
        ['最近错误', diagnostics.last_error ? formatDiagnosticValue(diagnostics.last_error) : '-']
      ];
      return '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">诊断摘要</span><div style="margin-top:4px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">' + items.map((item) => '<div style="padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel-strong);"><span class="muted" style="font-size:11px;">' + escapeHtml(item[0]) + '</span><div style="font-size:12px;word-break:break-all;">' + escapeHtml(String(item[1])) + '</div></div>').join('') + '</div></div>';
    }

    function renderTaskEvents(events) {
      if (!events.length) return '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">状态链</span><div class="notice" style="margin-top:4px;">暂无状态事件。</div></div>';
      const cols = '<colgroup><col style="width:170px"><col style="width:150px"><col style="width:96px"><col style="width:110px"><col></colgroup>';
      const rows = events.map((event) => '<tr><td class="time-cell">' + escapeHtml(formatDateTime(event.at)) + '</td><td>' + escapeHtml(stageText(event.stage) || '-') + '</td><td>' + escapeHtml(statusText(event.status) || '-') + '</td><td>' + escapeHtml(providerStatusText(event.provider_status)) + '</td><td>' + escapeHtml(formatTaskEventSummary(event)) + '</td></tr>').join('');
      return '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">状态链</span><div class="task-events-scroll"><table class="task-events-table">' + cols + '<thead><tr><th>时间</th><th>阶段</th><th>平台状态</th><th>上游状态</th><th>摘要</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }

    function formatTaskEventSummary(event) {
      const parts = [];
      if (event.message) parts.push(translateDiagnosticText(event.message));
      if (event.provider_task_id) parts.push('上游任务 ID=' + event.provider_task_id);
      if (event.poll_url) parts.push('轮询 URL=' + event.poll_url);
      if (event.provider_response_code) parts.push('上游业务码=' + translateDiagnosticText(event.provider_response_code));
      if (event.http_status) parts.push('HTTP=' + event.http_status);
      if (event.attempt) parts.push('尝试次数=' + event.attempt);
      if (event.delay_seconds !== undefined) parts.push('延迟=' + event.delay_seconds + ' 秒');
      if (event.request_id) parts.push('请求 ID=' + event.request_id);
      if (event.process_id) parts.push('处理进程=' + event.process_id);
      if (event.error) parts.push('错误=' + formatDiagnosticValue(event.error));
      if (event.details) parts.push('详情=' + formatDiagnosticValue(event.details));
      return parts.length ? parts.join(' · ') : '-';
    }

    function formatDiagnosticValue(value) {
      if (value === null || value === undefined) return '-';
      if (typeof value === 'string') return translateDiagnosticText(value);
      if (typeof value === 'object') return JSON.stringify(localizeDiagnosticValue(value));
      return String(value);
    }

    function localizeDiagnosticValue(value) {
      if (Array.isArray(value)) return value.map(localizeDiagnosticValue);
      if (value && typeof value === 'object') {
        return Object.keys(value).reduce((result, key) => {
          result[diagnosticKeyText(key)] = localizeDiagnosticValue(value[key]);
          return result;
        }, {});
      }
      if (typeof value === 'string') return translateDiagnosticText(value);
      return value;
    }

    function diagnosticKeyText(key) {
      const map = {
        message: '消息',
        cause: '原因',
        error: '错误',
        errors: '错误列表',
        response: '响应',
        data: '数据',
        code: '业务码',
        status: '状态',
        type: '类型',
        id: 'ID',
        task_id: '任务 ID',
        provider_task_id: '上游任务 ID',
        provider_status: '上游状态',
        provider_response_code: '上游业务码',
        provider_http_status: '上游 HTTP',
        http_status: 'HTTP 状态',
        output_count: '输出数量',
        stored_count: '已存储数量',
        output_expires_at: '输出过期时间',
        poll_count: '轮询次数',
        poll_url: '轮询 URL',
        upstream_raw_body: '上游原始响应',
        raw_body: '原始响应',
        attempt: '尝试次数',
        delay_seconds: '延迟秒数',
        process_id: '处理进程',
        request_id: '请求 ID'
      };
      return map[key] || key;
    }

    function translateDiagnosticText(text) {
      if (text === null || text === undefined) return '-';
      const value = String(text);
      const map = {
        'Queue consumer picked up the task': '队列消费者已接收任务',
        'Task has no plugin_id or provider_context, cannot be processed by consumer': '任务缺少 plugin_id 或 provider_context，队列消费者无法处理',
        'Missing provider routing context': '缺少上游路由上下文',
        'Upstream task creation failed with a non-retryable error': '上游任务创建失败，错误不可重试',
        'Upstream creation returned a non-retryable error': '上游创建返回不可重试错误',
        'Exceeded max upstream creation attempts': '已超过上游创建最大尝试次数',
        'Cannot build provider request context from task record': '无法根据任务记录构建上游请求上下文',
        'Polling upstream task status': '正在轮询上游任务状态',
        'Provider does not implement pollTask': 'Provider 未实现 pollTask',
        'Upstream task failed': '上游任务失败',
        'TASK_QUEUE binding is not configured': '未配置 TASK_QUEUE 绑定',
        'Task scheduled for the next processor run': '任务已安排到下一次处理',
        'Task scheduled without delayed delivery': '任务已安排处理，但未使用延迟投递',
        'Cannot build request context for upstream task creation': '无法为上游任务创建构建请求上下文',
        'Cannot build provider request context': '无法构建上游请求上下文',
        'Creating upstream async task': '正在创建上游异步任务',
        'Provider does not support image generation': 'Provider 不支持图片生成',
        'Upstream creation returned 202 without provider_task_id': '上游创建返回 202，但缺少 provider_task_id',
        'Missing provider_task_id in upstream creation response': '上游创建响应缺少 provider_task_id',
        'Upstream creation returned a non-success response': '上游创建返回非成功响应',
        'Unsupported task type for upstream creation': '上游创建不支持该任务类型',
        'Delivering terminal task webhook': '正在投递任务终态回调',
        'Callback endpoint returned non-2xx status': '回调地址返回非 2xx 状态',
        'Task created via /v1/tasks': '任务通过 /v1/tasks 创建',
        'Task created via /v1/async/images/generations': '任务通过 /v1/async/images/generations 创建',
        'Task created via account center test': '任务通过账户中心测试创建',
        'Task submitted to TASK_QUEUE': '任务已提交到 TASK_QUEUE',
        'Task canceled by API request': '任务已由 API 请求取消',
        'Task canceled from account center': '任务已在账户中心取消',
        'Task canceled by admin': '任务已由管理员取消'
      };
      if (map[value]) return map[value];
      let matched = value.match(/^Exceeded max poll attempts \((\d+)\)$/);
      if (matched) return '已超过最大轮询次数（' + matched[1] + '）';
      matched = value.match(/^Upstream task creation failed after (\d+) attempts$/);
      if (matched) return '上游任务创建失败，已尝试 ' + matched[1] + ' 次';
      matched = value.match(/^Provider "(.+)" does not implement pollTask$/);
      if (matched) return 'Provider "' + matched[1] + '" 未实现 pollTask';
      matched = value.match(/^Provider "(.+)" does not support image generation$/);
      if (matched) return 'Provider "' + matched[1] + '" 不支持图片生成';
      matched = value.match(/^Unsupported task type for auto-creation: (.+)$/);
      if (matched) return '不支持自动创建的任务类型：' + matched[1];
      matched = value.match(/^Upstream creation failed: (.+)$/);
      if (matched) return '上游创建失败：' + matched[1];
      return value;
    }

    function formatDate(dateString) {
      if (!dateString) return '-';
      const date = new Date(dateString);
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function formatDateTime(dateString) {
      if (!dateString) return '-';
      const date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return String(dateString);
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

    function resetKeyForm() {
      $('#keyName').value = '默认密钥';
      $('#keyPermanent').checked = true;
      $('#keyExpires').disabled = true;
      $('#keyExpires').value = '';
      $('#expiresLabel').style.opacity = '0.45';
      $('#expiresBadge').textContent = '过期：永不';
      $('#keyAllModels').checked = true;
      $('#keyModels').disabled = true;
      Array.from($('#keyModels').options).forEach((option) => { option.selected = false; });
      $('#modelsLabel').style.opacity = '0.45';
      $('#modelsBadge').textContent = '模型：全部';
      $('#secretBox').style.display = 'none';
      $('#secretBox').innerHTML = '';
    }

    function openKeyModal() {
      resetKeyForm();
      keyModal.classList.add('open');
      keyModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      $('#keyName').focus();
    }

    function closeKeyModal() {
      keyModal.classList.remove('open');
      keyModal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }

    async function openTaskDetailModal(taskId) {
      taskModalTitle.textContent = '任务详情：' + taskId;
      taskModalBody.innerHTML = '<div class="notice" style="text-align:center;">正在加载任务详情...</div>';
      taskModal.classList.add('open');
      taskModal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');

      try {
        const data = await api('/account/api/tasks/' + encodeURIComponent(taskId));
        const task = data.task;
        taskModalTitle.textContent = '任务详情：' + task.id;
        taskModalBody.innerHTML = renderTaskDetailModalBody(task);
      } catch (error) {
        taskModalBody.innerHTML = '<div class="notice" style="color:var(--danger);">加载失败: ' + escapeHtml(error.message) + '</div>';
      }
    }

    function closeTaskDetailModal() {
      taskModal.classList.remove('open');
      taskModal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }

    function renderTaskDetailModalBody(task) {
      return '<div class="item" style="margin:4px 0;">' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">任务 ID</span><div><code>' + escapeHtml(task.id) + '</code></div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">类型</span><div>' + escapeHtml(task.type) + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">模型</span><div>' + escapeHtml(task.model) + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">状态</span><div><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(statusText(task.status)) + '</span></div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">上游</span><div>' + escapeHtml(task.upstream_id || '-') + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">Provider</span><div>' + escapeHtml(task.plugin_id || '-') + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">Provider 任务 ID</span><div><code>' + escapeHtml(task.provider_task_id || '-') + '</code></div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">存储输出</span><div>' + (task.store_output ? '是' : '否') + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">存储 TTL</span><div>' + task.storage_ttl_seconds + ' 秒</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">输出过期</span><div>' + escapeHtml(task.output_expires_at ? formatDate(task.output_expires_at) : '-') + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">回调 URL</span><div>' + escapeHtml(task.callback_url || '未设置') + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">创建时间</span><div>' + formatDate(task.created_at) + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">更新时间</span><div>' + formatDate(task.updated_at) + '</div></div>' +
          '<div><span class="muted" style="font-size:11px;font-weight:900;">完成时间</span><div>' + (task.completed_at ? formatDate(task.completed_at) : '-') + '</div></div>' +
          '</div>' +
          renderTaskDiagnostics(task.diagnostics) +
          renderTaskEvents(task.events || []) +
          (task.input ? '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">输入参数</span><pre style="margin-top:4px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);font-size:12px;max-height:150px;overflow:auto;">' + escapeHtml(JSON.stringify(task.input, null, 2)) + '</pre></div>' : '') +
          renderTaskOutputPreview(task) +
          (task.error ? '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;color:var(--danger);">错误信息</span><pre style="margin-top:4px;padding:10px;border:1px solid var(--danger);border-radius:12px;background:rgba(251,113,133,0.05);color:var(--danger);font-size:12px;max-height:150px;overflow:auto;">' + escapeHtml(typeof task.error === 'object' ? JSON.stringify(task.error, null, 2) : String(task.error)) + '</pre></div>' : '') +
          (task.metadata ? '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">元数据</span><pre style="margin-top:4px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);font-size:12px;max-height:150px;overflow:auto;">' + escapeHtml(JSON.stringify(task.metadata, null, 2)) + '</pre></div>' : '') +
          '<div style="margin-top:12px;text-align:right;"><button class="compact secondary" type="button" data-task-modal-close>关闭</button></div>' +
          '</div>';
    }

    function renderTaskOutputPreview(task) {
      if (!task.output) return '';

      const output = Array.isArray(task.output) ? task.output : [];
      const images = output.filter((item) => item && (item.url || item.b64_json));

      let html = '<div style="margin-top:12px;"><span class="muted" style="font-size:11px;font-weight:900;">输出结果</span>';

      if (images.length > 0) {
        html += '<div style="margin-top:4px;"><div class="image-preview-grid">' +
          images.map((item, index) => {
            const src = imageOutputSrc(item);
            const label = item.stored ? '已转存' : (item.source === 'upstream' ? '上游 URL' : '图片');
            const openLink = item.url ? '<a href="' + escapeHtml(item.url) + '" target="_blank" rel="noreferrer">打开原图</a>' : '<span class="muted">Base64</span>';
            return '<article class="image-preview-card"><img src="' + escapeHtml(src) + '" alt="生成图片 ' + (index + 1) + '" loading="lazy"><footer><span>' + escapeHtml(label) + ' #' + (index + 1) + '</span>' + openLink + '</footer></article>';
          }).join('') +
          '</div></div>';
      }

      html += '<div style="margin-top:' + (images.length > 0 ? '8' : '4') + 'px;"><pre style="padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);font-size:12px;max-height:150px;overflow:auto;">' + escapeHtml(JSON.stringify(task.output, null, 2)) + '</pre></div></div>';

      return html;
    }

    function activateSection(sectionId) {
      document.querySelectorAll('.section').forEach((el) => el.style.display = 'none');
      document.querySelectorAll('.nav a').forEach((el) => el.classList.remove('active'));
      const section = $('#' + sectionId);
      const navLink = document.querySelector('.nav a[data-section="' + sectionId + '"]');
      if (section) section.style.display = 'block';
      if (navLink) navLink.classList.add('active');
      $('#page-title').textContent = pageTitles[sectionId] || '仪表盘';
      window.history.pushState({ section: sectionId }, '', '#' + sectionId);
    }

    $('#profileForm').addEventListener('submit', async (event) => {
       event.preventDefault();
       await api('/account/api/profile', { method: 'PATCH', body: JSON.stringify({ name: $('#profileName').value }) });
       await load();
     });

     $('#testForm').addEventListener('submit', async (event) => {
       event.preventDefault();
       const selectedModel = selectedTestModel();
       if (!selectedModel) return;
       const model = selectedModel.id;
        const isText = selectedModel.modality === 'text';
        const prompt = $('#testPrompt').value;
        clearTestTaskPoll();
         
        $('#testResult').style.display = 'none';
        $('#testEmpty').style.display = 'block';
        $('#testPreview').innerHTML = '';
        $('#testSubmit').disabled = true;
       
       const startTime = Date.now();
        
       try {
         const body = { model, mode: isText ? $('#testMode').value : 'task', prompt };
         if (isText) {
           body.temperature = parseFloat($('#testTemperature').value) || 0.7;
           body.max_tokens = parseInt($('#testMaxTokens').value) || 1000;
         } else {
           body.input = parseTestInputJson();
           body.store_output = $('#testStoreOutput').checked;
           body.storage_ttl_seconds = parseInt($('#testStorageTtl').value, 10) || 86400;
         }
         const result = await api('/account/api/test', {
           method: 'POST',
           body: JSON.stringify(body)
         });
          
          const duration = Date.now() - startTime;
          $('#testStatus').textContent = result.mode === 'async_task' ? '已创建任务' : '成功';
          $('#testDuration').textContent = duration;
          $('#testOutput').textContent = JSON.stringify(result, null, 2);
          $('#testEmpty').style.display = 'none';
          $('#testResult').style.display = 'block';
          if (result.mode === 'async_task' && result.task) {
            renderTestTaskPreview(result.task, selectedModel.modality === 'image' ? '生图任务已创建，正在自动等待图片结果...' : '任务已创建，正在自动等待结果...');
            activeTestTaskId = result.task.id;
            activeTestTaskPoll = setTimeout(() => pollTestTask(result.task.id), 1200);
            await load();
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          $('#testStatus').textContent = '失败';
          $('#testDuration').textContent = duration;
          $('#testPreview').innerHTML = '';
          $('#testOutput').textContent = error.message;
         $('#testEmpty').style.display = 'none';
         $('#testResult').style.display = 'block';
       } finally {
         $('#testSubmit').disabled = false;
       }
     });

     $('#testAdvanced').addEventListener('change', () => {
       const checked = $('#testAdvanced').checked;
       const model = selectedTestModel();
       $('#advancedParams').style.display = checked && model && model.modality === 'text' ? 'grid' : 'none';
     });

     $('#testModel').addEventListener('change', () => {
       $('#testInputJson').value = '';
       updateTestFormForModel();
     });

    $('#keyForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const permanent = $('#keyPermanent').checked;
      const allModels = $('#keyAllModels').checked;
      const allowedModels = allModels ? [] : Array.from($('#keyModels').selectedOptions).map((option) => option.value);
      const expiresAt = permanent ? null : ($('#keyExpires').value ? new Date($('#keyExpires').value).toISOString() : null);
      $('#secretBox').style.display = 'none';
      $('#secretBox').innerHTML = '';
      const created = await api('/account/api/api-keys', { method: 'POST', body: JSON.stringify({ name: $('#keyName').value, allowed_models: allowedModels, expires_at: expiresAt }) });
      $('#secretBox').style.display = 'block';
      $('#secretBox').innerHTML = '<strong>密钥已创建，请立即复制：</strong><p><code>' + escapeHtml(created.secret) + '</code></p><button class="compact" id="copySecret">复制</button><p class="muted">' + escapeHtml(created.warning) + '</p>';
      $('#copySecret').addEventListener('click', () => navigator.clipboard?.writeText(created.secret));
      await load();
    });

    $('#keyPermanent').addEventListener('change', () => {
      const permanent = $('#keyPermanent').checked;
      $('#keyExpires').disabled = permanent;
      $('#keyExpires').value = '';
      $('#expiresLabel').style.opacity = permanent ? '0.45' : '1';
      $('#expiresBadge').textContent = permanent ? '过期：永不' : ($('#keyExpires').value ? '过期：已设定' : '过期：未设');
    });

    $('#keyAllModels').addEventListener('change', () => {
      const allModels = $('#keyAllModels').checked;
      $('#keyModels').disabled = allModels;
      if (allModels) Array.from($('#keyModels').options).forEach((option) => { option.selected = false; });
      $('#modelsLabel').style.opacity = allModels ? '0.45' : '1';
      $('#modelsBadge').textContent = allModels ? '模型：全部' : '模型：已限定';
    });

    $('#openKeyModal').addEventListener('click', openKeyModal);

    $('#theme-toggle').addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      $('#theme-toggle').textContent = newTheme === 'dark' ? '切换浅色' : '切换深色';
      localStorage.setItem('theme', newTheme);
    });

    $('#refresh').addEventListener('click', () => {
      $('#status').textContent = '正在刷新...';
      load().then(() => { $('#status').textContent = '已刷新'; });
    });

    document.querySelectorAll('.nav a').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const sectionId = link.getAttribute('data-section');
        activateSection(sectionId);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && keyModal.classList.contains('open')) {
        closeKeyModal();
        return;
      }
      if (event.key === 'Escape' && taskModal.classList.contains('open')) {
        closeTaskDetailModal();
      }
    });

    document.addEventListener('click', async (event) => {
      const closeKeyModalButton = event.target.closest('[data-key-modal-close]');
      if (closeKeyModalButton) {
        closeKeyModal();
        return;
      }

      const closeTaskModal = event.target.closest('[data-task-modal-close]');
      if (closeTaskModal) {
        closeTaskDetailModal();
        return;
      }

      const disableKey = event.target.closest('[data-disable-key]');
      if (disableKey && confirm('确定禁用这个 API Key？')) {
        await api('/account/api/api-keys/' + encodeURIComponent(disableKey.dataset.disableKey), { method: 'DELETE' });
        await load();
      }
      const revealKey = event.target.closest('[data-reveal-key]');
      if (revealKey) {
        const keyId = revealKey.dataset.revealKey;
        const box = $('#reveal-' + keyId);
        const isOpen = box.style.display === 'block';
        if (isOpen) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        box.innerHTML = '<label class="full">请输入访问口令以验证身份<input id="reveal-token-' + keyId + '" type="password" placeholder="用户中心访问口令" autocomplete="current-password"></label><button class="compact" id="reveal-confirm-' + keyId + '" type="button">验证并查看</button><div id="reveal-result-' + keyId + '"></div>';
        $('#reveal-confirm-' + keyId).addEventListener('click', async () => {
          const accessToken = $('#reveal-token-' + keyId).value;
          if (!accessToken) return;
          try {
            const data = await api('/account/api/api-keys/' + encodeURIComponent(keyId) + '/reveal', { method: 'POST', body: JSON.stringify({ access_token: accessToken }) });
            $('#reveal-result-' + keyId).innerHTML = '<strong>密钥明文：</strong><p class="row"><code style="word-break:break-all;flex:1;">' + escapeHtml(data.token) + '</code><button class="compact" id="copy-reveal-' + keyId + '" type="button">复制</button></p><p class="muted">请妥善保管。</p>';
            $('#copy-reveal-' + keyId).addEventListener('click', () => { navigator.clipboard.writeText(data.token); $('#status').textContent = '密钥已复制到剪贴板'; });
            $('#reveal-token-' + keyId).value = '';
          } catch (error) {
            $('#reveal-result-' + keyId).innerHTML = '<p class="muted" style="color:var(--danger);">' + escapeHtml(error.message) + '</p>';
          }
        });
      }
      const cancelTask = event.target.closest('[data-cancel-task]');
      if (cancelTask && confirm('确定取消这个任务？')) {
        await api('/account/api/tasks/' + encodeURIComponent(cancelTask.dataset.cancelTask) + '/cancel', { method: 'POST' });
        await load();
      }
      const viewTask = event.target.closest('[data-view-task]');
      if (viewTask) {
        const taskId = viewTask.dataset.viewTask;
        await openTaskDetailModal(taskId);
      }
    });

    document.addEventListener('visibilitychange', refreshAfterTabSwitch);
    window.addEventListener('focus', refreshAfterTabSwitch);

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }

    function apiDocsToMarkdown() {
      const section = document.querySelector('#api-docs');
      if (!section) return '';
      const BQ = String.fromCharCode(96);
      const FENCE = BQ + BQ + BQ;
      const lines = [];
      const blocks = section.querySelectorAll('.doc-block');
      for (const block of blocks) {
        const heading = block.querySelector('h3');
        if (heading) lines.push('## ' + heading.textContent.trim(), '');
        for (const node of block.children) {
          if (node.classList.contains('card-head')) continue;
          if (node.tagName === 'H3') continue;
          if (node.tagName === 'P') { lines.push(node.textContent.trim(), ''); continue; }
          if (node.tagName === 'TABLE') {
            const rows = node.querySelectorAll('tr');
            for (let i = 0; i < rows.length; i++) {
              const cells = rows[i].querySelectorAll('th, td');
              const row = '| ' + Array.from(cells).map(c => c.textContent.trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
              lines.push(row);
              if (i === 0) lines.push('| ' + Array.from(cells).map(() => '---').join(' | ') + ' |');
            }
            lines.push('');
            continue;
          }
          if (node.tagName === 'UL') {
            for (const li of node.querySelectorAll('li')) lines.push('- ' + li.textContent.trim());
            lines.push('');
            continue;
          }
          if (node.tagName === 'PRE') {
            const code = node.querySelector('code') || node;
            lines.push(FENCE + 'json', code.textContent.trim(), FENCE, '');
            continue;
          }
          if (node.tagName === 'DIV') {
            if (node.id === 'mediaModelDocs') continue;
            const preEl = node.querySelector('pre');
            if (preEl) {
              const code = preEl.querySelector('code') || preEl;
              lines.push(FENCE + 'json', code.textContent.trim(), FENCE, '');
            } else {
              const codeEl = node.querySelector('code');
              if (codeEl) lines.push(FENCE, codeEl.textContent.trim(), FENCE, '');
            }
          }
        }
      }
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    $('#copyApiDocs')?.addEventListener('click', async () => {
      const btn = $('#copyApiDocs');
      try {
        const md = apiDocsToMarkdown();
        await navigator.clipboard.writeText(md);
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '复制为 Markdown'; btn.classList.remove('copied'); }, 2000);
      } catch { btn.textContent = '复制失败'; setTimeout(() => { btn.textContent = '复制为 Markdown'; }, 2000); }
    });

    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    $('#theme-toggle').textContent = savedTheme === 'dark' ? '切换浅色' : '切换深色';

    const initialSection = window.location.hash.slice(1) || 'dashboard';
    activateSection(initialSection);

    load().catch((error) => {
      document.body.innerHTML = '<div class="layout"><main class="content"><div class="card"><h1>载入失败</h1><p class="subtitle">' + escapeHtml(error.message) + '</p><p><a href="/account/login" style="color: var(--accent)">重新登录</a></p></div></main></div>';
    });
  </script>
</body>
</html>`;
}
