import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  authenticateAdmin,
  createAdminSession,
  verifyAdminPassword
} from "../auth/admin";
import { loadGatewayConfig, validateGatewayConfig } from "../config";
import { conflict, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import type { ProviderPluginManifest } from "../providers/types";
import { getTask, listTasks, saveTask } from "../tasks/store";
import type { AsyncTaskRecord, AsyncTaskStatus, Env, GatewayConfig, ModelConfig, ProviderRouteConfig } from "../types";
import { readJsonObject, requireString } from "../utils/request";

const DEFAULT_TASK_LIMIT = 50;
const MAX_TASK_LIMIT = 100;

export async function handleAdminRequest(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string
): Promise<Response> {
  if (request.method === "GET" && pathname === "/admin/login") {
    if (await isAdminAuthenticated(request, env)) {
      return redirectResponse("/admin", requestId);
    }

    return htmlResponse(renderAdminLoginHtml(), {
      headers: {
        "X-Request-Id": requestId
      }
    });
  }

  if (request.method === "POST" && pathname === "/admin/login") {
    return handleAdminLogin(request, env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/logout") {
    return redirectResponse("/admin/login", requestId, {
      headers: {
        "Set-Cookie": serializeAdminSessionCookie(request, "", 0)
      }
    });
  }

  if (request.method === "GET" && pathname === "/admin") {
    if (!(await isAdminAuthenticated(request, env))) {
      return redirectResponse("/admin/login", requestId);
    }

    return htmlResponse(ADMIN_HTML, {
      headers: {
        "X-Request-Id": requestId
      }
    });
  }

  if (!pathname.startsWith("/admin/api/")) {
    throw notFound("接口不存在");
  }

  await authenticateAdmin(request, env);

  const url = new URL(request.url);

  if (request.method === "GET" && pathname === "/admin/api/overview") {
    return handleAdminOverview(env, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/config") {
    return handleAdminConfig(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/config/validate") {
    return handleValidateConfig(request, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/tasks") {
    return handleListAdminTasks(url.searchParams, env, requestId);
  }

  const taskCancelMatch = pathname.match(/^\/admin\/api\/tasks\/([^/]+)\/cancel$/);
  if (request.method === "POST" && taskCancelMatch) {
    return handleCancelAdminTask(decodeURIComponent(taskCancelMatch[1]), env, requestId);
  }

  const taskMatch = pathname.match(/^\/admin\/api\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    return handleGetAdminTask(decodeURIComponent(taskMatch[1]), env, requestId);
  }

  const providerHealthMatch = pathname.match(/^\/admin\/api\/providers\/([^/]+)\/health$/);
  if (request.method === "GET" && providerHealthMatch) {
    return handleProviderHealth(decodeURIComponent(providerHealthMatch[1]), env, requestId);
  }

  throw notFound("接口不存在");
}

async function handleAdminLogin(request: Request, env: Env, requestId: string): Promise<Response> {
  try {
    const form = await request.formData();
    const password = String(form.get("password") || "").trim();
    if (!password) {
      return renderLoginError("请输入管理员密码。", requestId, 400);
    }

    if (!(await verifyAdminPassword(password, env))) {
      return renderLoginError("管理员密码不正确。", requestId, 401);
    }

    const session = await createAdminSession(env);
    return redirectResponse("/admin", requestId, {
      headers: {
        "Set-Cookie": serializeAdminSessionCookie(request, session, ADMIN_SESSION_TTL_SECONDS)
      }
    });
  } catch (error) {
    return renderLoginError(error instanceof Error ? error.message : "登录失败。", requestId, 500);
  }
}

async function isAdminAuthenticated(request: Request, env: Env): Promise<boolean> {
  try {
    await authenticateAdmin(request, env);
    return true;
  } catch {
    return false;
  }
}

function renderLoginError(message: string, requestId: string, status: number): Response {
  return htmlResponse(renderAdminLoginHtml(message), {
    status,
    headers: {
      "X-Request-Id": requestId
    }
  });
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

function serializeAdminSessionCookie(request: Request, value: string, maxAge: number): string {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/admin",
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

async function handleAdminOverview(env: Env, requestId: string): Promise<Response> {
  const config = loadGatewayConfig(env);
  const registry = createProviderRegistry(env);
  const tasks = await listTasks(env, MAX_TASK_LIMIT);
  const routeStats = summarizeRoutes(config, env);
  const taskStats = summarizeTasks(tasks);

  return jsonResponse(
    {
      status: "ok",
      generated_at: new Date().toISOString(),
      gateway: buildGatewayInfo(env),
      stats: {
        models_total: config.models.length,
        models_active: config.models.filter((model) => model.status !== "disabled").length,
        routes_total: routeStats.total,
        routes_active: routeStats.active,
        routes_configured: routeStats.configured,
        providers_total: registry.list().length,
        recent_tasks: tasks.length,
        tasks_running: taskStats.running,
        tasks_failed: taskStats.failed
      },
      task_stats: taskStats,
      warnings: buildWarnings(env, config),
      models: config.models.map((model) => publicModel(model, env)),
      providers: registry.list().map((plugin) => publicProvider(plugin.manifest, config, env)),
      provider_config: {
        openai_compatible_base_url: env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
        openai_compatible_default_model: env.OPENAI_COMPATIBLE_DEFAULT_MODEL || "gpt-4o-mini",
        openai_compatible_api_key_configured: Boolean(env.OPENAI_COMPATIBLE_API_KEY)
      },
      feature_matrix: buildFeatureMatrix(env),
      endpoints: buildEndpointList(),
      recent_tasks: tasks.slice(0, 25).map(publicTaskSummary)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleAdminConfig(env: Env, requestId: string): Promise<Response> {
  const config = loadGatewayConfig(env);
  const routes = config.models.flatMap((model) => model.routes.map((route) => ({ model, route })));

  return jsonResponse(
    {
      source: env.MODEL_CONFIG_JSON ? "MODEL_CONFIG_JSON" : "环境默认值",
      valid: true,
      config,
      config_json: JSON.stringify(config, null, 2),
      summary: {
        models_total: config.models.length,
        routes_total: routes.length,
        routes_configured: routes.filter(({ route }) => isRouteCredentialConfigured(env, route)).length
      },
      example_chat_request: {
        endpoint: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: "Bearer <DEV_API_KEY>",
          "Content-Type": "application/json"
        },
        body: {
          model: config.models[0]?.alias || "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: false
        }
      }
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleListAdminTasks(searchParams: URLSearchParams, env: Env, requestId: string): Promise<Response> {
  const limit = normalizeTaskLimit(searchParams.get("limit"));
  const allTasks = await listTasks(env, MAX_TASK_LIMIT);
  const tasks = filterTasks(allTasks, searchParams).slice(0, limit);

  return jsonResponse(
    {
      object: "list",
      limit,
      returned: tasks.length,
      available_sample: allTasks.length,
      data: tasks.map(publicTaskSummary),
      stats: summarizeTasks(allTasks)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleGetAdminTask(taskId: string, env: Env, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task) {
    throw notFound("任务不存在");
  }

  return jsonResponse(
    {
      task
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleCancelAdminTask(taskId: string, env: Env, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task) {
    throw notFound("任务不存在");
  }

  if (!isCancelableTask(task)) {
    throw conflict(`任务当前状态不可取消：${task.status}`);
  }

  const now = new Date().toISOString();
  task.status = "canceled";
  task.updated_at = now;
  task.completed_at = now;
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

async function handleProviderHealth(pluginId: string, env: Env, requestId: string): Promise<Response> {
  const config = loadGatewayConfig(env);
  const registry = createProviderRegistry(env);
  const plugin = registry.get(pluginId);
  const health = buildProviderHealth(plugin.manifest, config, env);
  const candidate = firstConfiguredRoute(config, env, pluginId);

  if (candidate) {
    const adapter = plugin.createAdapter(env);
    if (adapter.healthCheck) {
      try {
        await adapter.healthCheck({
          env,
          request_id: requestId,
          route: candidate,
          credential: resolveProviderCredential(env, candidate)
        });
        health.adapter_check = "passed";
      } catch (error) {
        health.status = "error";
        health.adapter_check = error instanceof Error ? error.message : "health check failed";
      }
    }
  }

  return jsonResponse(
    {
      provider: health
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleValidateConfig(request: Request, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const configJson = requireString(body.config_json, "config_json");

  try {
    const config = JSON.parse(configJson) as GatewayConfig;
    validateGatewayConfig(config);

    return jsonResponse(
      {
        valid: true,
        models_total: config.models.length,
        routes_total: config.models.reduce((count, model) => count + model.routes.length, 0)
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  } catch (error) {
    return jsonResponse(
      {
        valid: false,
        error: error instanceof Error ? error.message : "配置无效"
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  }
}

function publicModel(model: ModelConfig, env: Env): Record<string, unknown> {
  const selectedRoute = model.routes
    .filter((route) => route.status !== "disabled")
    .sort((left, right) => (left.priority || 100) - (right.priority || 100))[0];

  return {
    alias: model.alias,
    modality: model.modality,
    supports_stream: model.supports_stream !== false,
    status: model.status || "active",
    routes: model.routes.map((route) => ({
      plugin_id: route.plugin_id,
      provider: route.provider,
      provider_model: route.provider_model,
      credential_id: route.credential_id || null,
      credential_configured: isRouteCredentialConfigured(env, route),
      priority: route.priority ?? null,
      weight: route.weight ?? null,
      status: route.status || "active",
      selected: route === selectedRoute
    }))
  };
}

function publicProvider(manifest: ProviderPluginManifest, config: GatewayConfig, env: Env): Record<string, unknown> {
  return buildProviderHealth(manifest, config, env);
}

function publicTaskSummary(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    tenant_id: task.tenant_id,
    api_key_id: task.api_key_id,
    type: task.type,
    model: task.model,
    status: task.status,
    cancelable: isCancelableTask(task),
    store_output: task.store_output,
    callback_url: task.callback_url || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    error: task.error
  };
}

function buildGatewayInfo(env: Env): Record<string, unknown> {
  return {
    auth_mode: env.AUTH_MODE || "api_key",
    admin_session_ttl_seconds: ADMIN_SESSION_TTL_SECONDS,
    config_source: env.MODEL_CONFIG_JSON ? "MODEL_CONFIG_JSON" : "环境默认值",
    task_store: env.AI_GATEWAY_KV ? "kv" : "memory",
    db_bound: Boolean(env.DB),
    kv_bound: Boolean(env.AI_GATEWAY_KV),
    queue_bound: Boolean(env.TASK_QUEUE),
    r2_bound: Boolean(env.FILES),
    dev_api_key_configured: Boolean(env.DEV_API_KEY),
    admin_auth_configured: Boolean(env.ADMIN_TOKEN)
  };
}

function buildWarnings(env: Env, config: GatewayConfig): string[] {
  const warnings: string[] = [];

  if (!env.ADMIN_TOKEN) {
    warnings.push("未配置 ADMIN_TOKEN，管理后台无法登录。");
  }
  if (!env.DEV_API_KEY && env.AUTH_MODE !== "none") {
    warnings.push("未配置 DEV_API_KEY，用户 API 认证将失败。");
  }
  if (!env.OPENAI_COMPATIBLE_API_KEY) {
    warnings.push("未配置 OPENAI_COMPATIBLE_API_KEY，默认供应商的聊天补全将失败。");
  }
  if (!env.AI_GATEWAY_KV) {
    warnings.push("未绑定 AI_GATEWAY_KV，任务将存储在内存中，可能在 isolate 之间丢失。");
  }
  if (!env.DB) {
    warnings.push("未绑定 DB，租户、API key、配额和计费管理尚无法持久化。");
  }
  if (!env.TASK_QUEUE) {
    warnings.push("未绑定 TASK_QUEUE，异步任务只会入库，不会被后台队列处理。");
  }
  if (!env.FILES) {
    warnings.push("未绑定 FILES，异步任务输出转存 R2 的能力尚不可用。");
  }

  for (const model of config.models) {
    if (model.status === "disabled") {
      continue;
    }

    const activeRoutes = model.routes.filter((route) => route.status !== "disabled");
    if (activeRoutes.length === 0) {
      warnings.push(`模型 ${model.alias} 没有可用路由。`);
    }
    for (const route of activeRoutes) {
      if (!isRouteCredentialConfigured(env, route)) {
        warnings.push(`模型 ${model.alias} 的路由 ${route.plugin_id}/${route.provider_model} 缺少凭证。`);
      }
    }
  }

  return warnings;
}

function buildProviderHealth(manifest: ProviderPluginManifest, config: GatewayConfig, env: Env): Record<string, unknown> {
  const routes = config.models.flatMap((model) =>
    model.routes
      .filter((route) => route.plugin_id === manifest.id)
      .map((route) => ({ model_alias: model.alias, route }))
  );
  const activeRoutes = routes.filter(({ route }) => route.status !== "disabled");
  const configuredRoutes = activeRoutes.filter(({ route }) => isRouteCredentialConfigured(env, route));
  const status = activeRoutes.length === 0 ? "warning" : configuredRoutes.length === activeRoutes.length ? "ok" : "error";

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    runtime: manifest.runtime,
    status,
    capabilities: manifest.capabilities,
    configured: status === "ok",
    routes_total: routes.length,
    routes_active: activeRoutes.length,
    routes_configured: configuredRoutes.length,
    routes: routes.map(({ model_alias, route }) => ({
      model_alias,
      provider_model: route.provider_model,
      credential_id: route.credential_id || null,
      credential_configured: isRouteCredentialConfigured(env, route),
      status: route.status || "active"
    })),
    adapter_check: "not_run"
  };
}

function buildFeatureMatrix(env: Env): Array<Record<string, unknown>> {
  return [
    {
      name: "管理后台登录",
      status: env.ADMIN_TOKEN ? "ready" : "blocked",
      detail: env.ADMIN_TOKEN ? "已启用 HttpOnly 会话" : "需要 ADMIN_TOKEN"
    },
    {
      name: "用户 API 鉴权",
      status: env.AUTH_MODE === "none" || env.DEV_API_KEY ? "ready" : "blocked",
      detail: env.AUTH_MODE === "none" ? "AUTH_MODE=none" : env.DEV_API_KEY ? "DEV_API_KEY 已配置" : "需要 DEV_API_KEY"
    },
    {
      name: "模型路由",
      status: env.MODEL_CONFIG_JSON ? "ready" : "partial",
      detail: env.MODEL_CONFIG_JSON ? "使用 MODEL_CONFIG_JSON" : "使用默认单模型路由"
    },
    {
      name: "任务持久化",
      status: env.AI_GATEWAY_KV ? "ready" : "partial",
      detail: env.AI_GATEWAY_KV ? "AI_GATEWAY_KV 已绑定" : "当前为内存存储"
    },
    {
      name: "异步任务执行",
      status: env.TASK_QUEUE ? "ready" : "blocked",
      detail: env.TASK_QUEUE ? "TASK_QUEUE 已绑定" : "缺少 TASK_QUEUE"
    },
    {
      name: "文件转存",
      status: env.FILES ? "ready" : "blocked",
      detail: env.FILES ? "FILES R2 已绑定" : "缺少 FILES 绑定"
    },
    {
      name: "租户与计费",
      status: env.DB ? "planned" : "blocked",
      detail: env.DB ? "DB 已绑定，数据模型待实现" : "需要 DB 和数据模型"
    }
  ];
}

function buildEndpointList(): Array<Record<string, string>> {
  return [
    { method: "GET", path: "/health", auth: "无" },
    { method: "GET", path: "/v1/models", auth: "DEV_API_KEY" },
    { method: "POST", path: "/v1/chat/completions", auth: "DEV_API_KEY" },
    { method: "POST", path: "/v1/tasks", auth: "DEV_API_KEY" },
    { method: "GET", path: "/v1/tasks/{task_id}", auth: "DEV_API_KEY" },
    { method: "POST", path: "/v1/tasks/{task_id}/cancel", auth: "DEV_API_KEY" },
    { method: "GET", path: "/admin/api/*", auth: "管理员会话" }
  ];
}

function summarizeRoutes(config: GatewayConfig, env: Env): Record<string, number> {
  let total = 0;
  let active = 0;
  let configured = 0;

  for (const model of config.models) {
    for (const route of model.routes) {
      total += 1;
      if (route.status !== "disabled") {
        active += 1;
      }
      if (route.status !== "disabled" && isRouteCredentialConfigured(env, route)) {
        configured += 1;
      }
    }
  }

  return { total, active, configured };
}

function summarizeTasks(tasks: AsyncTaskRecord[]): Record<AsyncTaskStatus | "total" | "running" | "failed", number> {
  const stats: Record<AsyncTaskStatus | "total" | "running" | "failed", number> = {
    total: tasks.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    expired: 0
  };

  for (const task of tasks) {
    stats[task.status] += 1;
  }

  return stats;
}

function filterTasks(tasks: AsyncTaskRecord[], searchParams: URLSearchParams): AsyncTaskRecord[] {
  const status = searchParams.get("status") || "";
  const model = searchParams.get("model") || "";
  const type = searchParams.get("type") || "";
  const query = (searchParams.get("q") || "").toLowerCase();

  return tasks.filter((task) => {
    if (status && task.status !== status) {
      return false;
    }
    if (model && task.model !== model) {
      return false;
    }
    if (type && task.type !== type) {
      return false;
    }
    if (query && !`${task.id} ${task.tenant_id} ${task.api_key_id} ${task.model} ${task.type}`.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });
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

function firstConfiguredRoute(config: GatewayConfig, env: Env, pluginId: string): ProviderRouteConfig | undefined {
  for (const model of config.models) {
    for (const route of model.routes) {
      if (route.plugin_id === pluginId && route.status !== "disabled" && isRouteCredentialConfigured(env, route)) {
        return route;
      }
    }
  }

  return undefined;
}

function isRouteCredentialConfigured(env: Env | undefined, route: ProviderRouteConfig): boolean {
  if (!env) {
    return false;
  }

  try {
    resolveProviderCredential(env, route);
    return true;
  } catch {
    return false;
  }
}

function isCancelableTask(task: AsyncTaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
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

function renderAdminLoginHtml(errorMessage = ""): string {
  const errorHtml = errorMessage ? `<div class="alert">${escapeHtml(errorMessage)}</div>` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 Teaven AI 管理后台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080b12;
      --panel: #111827;
      --line: #273244;
      --text: #f6f8fb;
      --muted: #9aa8bd;
      --accent: #7dd3fc;
      --accent-strong: #38bdf8;
      --danger: #fb7185;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 20% 15%, rgba(125, 211, 252, 0.2), transparent 26rem),
        radial-gradient(circle at 80% 85%, rgba(56, 189, 248, 0.12), transparent 24rem),
        linear-gradient(135deg, #070a10 0%, #0d1320 48%, #111827 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .login-shell {
      width: min(100%, 440px);
    }

    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.22em;
      margin-bottom: 12px;
      text-transform: uppercase;
    }

    .card {
      background: rgba(17, 24, 39, 0.84);
      border: 1px solid rgba(125, 211, 252, 0.16);
      border-radius: 26px;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.3);
      padding: 28px;
      backdrop-filter: blur(18px);
    }

    h1,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(34px, 9vw, 58px);
      letter-spacing: -0.06em;
      line-height: 0.95;
    }

    p {
      color: var(--muted);
      margin-top: 14px;
      line-height: 1.65;
    }

    form {
      display: grid;
      gap: 12px;
      margin-top: 26px;
    }

    label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    input,
    button {
      width: 100%;
      font: inherit;
    }

    input {
      color: var(--text);
      background: #0b1220;
      border: 1px solid var(--line);
      border-radius: 16px;
      outline: none;
      padding: 13px 14px;
    }

    input:focus {
      border-color: var(--accent-strong);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12);
    }

    button {
      border: 0;
      border-radius: 999px;
      color: #06111f;
      background: var(--accent);
      cursor: pointer;
      font-weight: 900;
      padding: 13px 16px;
      transition: transform 150ms ease, background 150ms ease;
    }

    button:hover {
      background: var(--accent-strong);
      transform: translateY(-1px);
    }

    .alert {
      margin-top: 16px;
      border: 1px solid rgba(251, 113, 133, 0.35);
      border-radius: 16px;
      background: rgba(251, 113, 133, 0.1);
      color: #fecdd3;
      padding: 12px 14px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="login-shell">
    <section class="card">
      <div class="eyebrow">Teaven AI Gateway</div>
      <h1>管理员登录</h1>
      <p>登录成功后将自动进入管理后台。</p>
      ${errorHtml}
      <form action="/admin/login" method="post">
        <label for="password">管理员密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">登录后台</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teaven AI 管理后台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090d14;
      --panel: #111827;
      --panel-strong: #172033;
      --line: #263244;
      --text: #f6f8fb;
      --muted: #9aa8bd;
      --accent: #7dd3fc;
      --accent-strong: #38bdf8;
      --danger: #fb7185;
      --ok: #86efac;
      --warn: #fbbf24;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(56, 189, 248, 0.16), transparent 30rem),
        linear-gradient(135deg, #070a10 0%, #0d1320 45%, #111827 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    .shell {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }

    .hero {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      margin-bottom: 24px;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(32px, 6vw, 64px);
      letter-spacing: -0.06em;
      line-height: 0.92;
    }

    h2 {
      font-size: 18px;
      letter-spacing: -0.02em;
    }

    .eyebrow {
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.22em;
      margin-bottom: 12px;
      text-transform: uppercase;
    }

    .subtitle {
      color: var(--muted);
      margin-top: 12px;
      max-width: 650px;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .toolbar form {
      margin: 0;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }

    .card {
      background: rgba(17, 24, 39, 0.82);
      border: 1px solid rgba(125, 211, 252, 0.14);
      border-radius: 22px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
      padding: 20px;
      backdrop-filter: blur(18px);
    }

    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-7 { grid-column: span 7; }
    .span-6 { grid-column: span 6; }
    .span-5 { grid-column: span 5; }
    .span-4 { grid-column: span 4; }

    .login {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      align-items: center;
    }

    input,
    textarea {
      width: 100%;
      color: var(--text);
      background: #0b1220;
      border: 1px solid var(--line);
      border-radius: 14px;
      outline: none;
      padding: 12px 14px;
    }

    textarea {
      min-height: 180px;
      resize: vertical;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
    }

    input:focus,
    textarea:focus {
      border-color: var(--accent-strong);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12);
    }

    button {
      border: 0;
      border-radius: 999px;
      color: #06111f;
      background: var(--accent);
      cursor: pointer;
      font-weight: 800;
      padding: 12px 16px;
      transition: transform 150ms ease, background 150ms ease;
      white-space: nowrap;
    }

    button:hover {
      background: var(--accent-strong);
      transform: translateY(-1px);
    }

    button.secondary {
      color: var(--text);
      background: #1f2937;
      border: 1px solid var(--line);
    }

    button.danger {
      color: #fff1f2;
      background: rgba(251, 113, 133, 0.18);
      border: 1px solid rgba(251, 113, 133, 0.4);
    }

    button.compact {
      padding: 7px 10px;
      font-size: 12px;
    }

    .status {
      margin-top: 10px;
      min-height: 22px;
      color: var(--muted);
      font-size: 13px;
    }

    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
    }

    .stat {
      padding: 16px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 18px;
    }

    .stat strong {
      display: block;
      font-size: 30px;
      letter-spacing: -0.04em;
    }

    .stat span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }

    .meta div {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #0b1220;
    }

    .meta span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 5px;
    }

    .meta strong {
      word-break: break-word;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
      align-items: end;
    }

    .form-grid label {
      color: var(--muted);
      display: grid;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
    }

    select {
      width: 100%;
      color: var(--text);
      background: #0b1220;
      border: 1px solid var(--line);
      border-radius: 14px;
      outline: none;
      padding: 12px 14px;
    }

    .table-wrap {
      overflow-x: auto;
    }

    .stack {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: #0b1220;
    }

    .panel h3 {
      font-size: 15px;
      margin-bottom: 8px;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14px;
      overflow: hidden;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 11px 8px;
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }

    th {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    code,
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--muted);
      background: #0b1220;
      font-size: 12px;
      margin: 2px 4px 2px 0;
    }

    .pill.ok { color: var(--ok); border-color: rgba(134, 239, 172, 0.35); }
    .pill.warn { color: var(--warn); border-color: rgba(251, 191, 36, 0.35); }
    .pill.danger { color: var(--danger); border-color: rgba(251, 113, 133, 0.35); }

    .warnings {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }

    .warning {
      padding: 12px;
      border-radius: 14px;
      border: 1px solid rgba(251, 191, 36, 0.25);
      background: rgba(251, 191, 36, 0.08);
      color: #fde68a;
      font-size: 13px;
    }

    .json-view {
      margin-top: 14px;
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--line);
      background: #070b12;
      color: #d5e3f5;
      overflow: auto;
      max-height: 360px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .empty {
      color: var(--muted);
      padding: 12px 0;
    }

    @media (max-width: 860px) {
      .shell {
        width: min(100% - 20px, 1180px);
        padding-top: 20px;
      }

      .hero,
      .login,
      .form-grid,
      .meta,
      .stat-grid {
        grid-template-columns: 1fr;
      }

      .toolbar {
        justify-content: stretch;
      }

      .toolbar button,
      .login button {
        width: 100%;
      }

      .span-4,
      .span-5,
      .span-6,
      .span-7,
      .span-8,
      .span-12 {
        grid-column: span 12;
      }

      table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div>
        <div class="eyebrow">Teaven AI Gateway</div>
        <h1>管理后台</h1>
        <p class="subtitle">管理当前 Worker 部署：查看模型、供应商接入、存储绑定和异步任务。</p>
      </div>
      <div class="toolbar">
        <button id="refresh" class="secondary" type="button">刷新</button>
        <form action="/admin/logout" method="post">
          <button class="secondary" type="submit">退出登录</button>
        </form>
      </div>
    </section>

    <section class="grid">
      <div class="card span-12">
        <h2>概览</h2>
        <div id="status" class="status">正在加载管理后台...</div>
        <div id="stats" class="stat-grid" style="margin-top: 14px;"></div>
        <div id="gateway-meta" class="meta"></div>
      </div>

      <div class="card span-12">
        <h2>告警</h2>
        <div id="warnings" class="warnings"></div>
      </div>

      <div class="card span-8">
        <h2>功能状态</h2>
        <div id="features" class="meta"></div>
      </div>

      <div class="card span-4">
        <h2>接口清单</h2>
        <div id="endpoints" class="stack"></div>
      </div>

      <div class="card span-8">
        <h2>模型与路由</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>别名</th>
                <th>模态</th>
                <th>状态</th>
                <th>流式</th>
                <th>路由</th>
              </tr>
            </thead>
            <tbody id="models"></tbody>
          </table>
        </div>
      </div>

      <div class="card span-4">
        <h2>供应商</h2>
        <div id="providers" style="margin-top: 14px;"></div>
      </div>

      <div class="card span-8">
        <h2>任务管理</h2>
        <div class="form-grid">
          <label>状态
            <select id="task-status-filter">
              <option value="">全部</option>
              <option value="queued">排队中</option>
              <option value="running">运行中</option>
              <option value="succeeded">成功</option>
              <option value="failed">失败</option>
              <option value="canceled">已取消</option>
              <option value="expired">已过期</option>
            </select>
          </label>
          <label>关键词
            <input id="task-query" type="text" placeholder="任务 ID / 模型 / 租户">
          </label>
          <label>数量
            <select id="task-limit">
              <option value="25">25</option>
              <option value="50" selected>50</option>
              <option value="100">100</option>
            </select>
          </label>
          <button id="reload-tasks" type="button">加载任务</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>类型</th>
                <th>模型</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="tasks"></tbody>
          </table>
        </div>
      </div>

      <div class="card span-4">
        <h2>任务详情</h2>
        <div class="login" style="grid-template-columns: 1fr auto; margin-top: 14px;">
          <input id="task-id" type="text" placeholder="task_xxx">
          <button id="lookup-task" type="button">查询</button>
        </div>
        <pre id="task-output" class="json-view">尚未加载任务。</pre>
      </div>

      <div class="card span-6">
        <h2>当前模型配置</h2>
        <p class="subtitle">这里展示 Worker 当前实际加载的 GatewayConfig，不包含任何密钥明文。</p>
        <pre id="current-config" class="json-view">正在加载配置...</pre>
      </div>

      <div class="card span-6">
        <h2>API 调用示例</h2>
        <p class="subtitle">用于快速验证当前模型别名和用户 API 鉴权。</p>
        <pre id="example-request" class="json-view">正在生成示例...</pre>
      </div>

      <div class="card span-12">
        <h2>MODEL_CONFIG_JSON 校验器</h2>
        <p class="subtitle">在部署为 MODEL_CONFIG_JSON 之前，先粘贴 GatewayConfig JSON 对象进行校验。</p>
        <textarea id="config-json" spellcheck="false" placeholder='{"models":[{"alias":"gpt-4o-mini","modality":"text","supports_stream":true,"status":"active","routes":[{"plugin_id":"openai-compatible","provider_model":"gpt-4o-mini","credential_id":"env:OPENAI_COMPATIBLE_API_KEY","priority":1,"weight":100,"status":"active"}]}]}'></textarea>
        <div class="toolbar" style="margin-top: 12px; justify-content: flex-start;">
          <button id="load-current-config" class="secondary" type="button">填入当前配置</button>
          <button id="validate-config" type="button">校验配置</button>
        </div>
        <pre id="config-output" class="json-view">尚未执行校验。</pre>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var statusEl = document.getElementById('status');
      var statsEl = document.getElementById('stats');
      var gatewayMetaEl = document.getElementById('gateway-meta');
      var warningsEl = document.getElementById('warnings');
      var featuresEl = document.getElementById('features');
      var endpointsEl = document.getElementById('endpoints');
      var modelsEl = document.getElementById('models');
      var providersEl = document.getElementById('providers');
      var tasksEl = document.getElementById('tasks');
      var taskOutputEl = document.getElementById('task-output');
      var currentConfigEl = document.getElementById('current-config');
      var exampleRequestEl = document.getElementById('example-request');
      var configOutputEl = document.getElementById('config-output');
      var configJsonEl = document.getElementById('config-json');
      var currentConfigJson = '';

      document.getElementById('refresh').addEventListener('click', loadAll);
      document.getElementById('lookup-task').addEventListener('click', lookupTask);
      document.getElementById('reload-tasks').addEventListener('click', loadTasks);
      document.getElementById('load-current-config').addEventListener('click', fillCurrentConfig);
      document.getElementById('validate-config').addEventListener('click', validateConfig);
      providersEl.addEventListener('click', handleProviderAction);
      tasksEl.addEventListener('click', handleTaskAction);

      loadAll();

      async function api(path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        if (options.body && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }

        var response = await fetch(path, Object.assign({}, options, { headers: headers, credentials: 'same-origin' }));
        var data = await response.json().catch(function () { return {}; });
        if (response.status === 401) {
          window.location.assign('/admin/login');
          throw new Error('登录已过期，请重新登录。');
        }
        if (!response.ok) {
          var message = data.error && data.error.message ? data.error.message : '请求失败，HTTP 状态码：' + response.status;
          throw new Error(message);
        }
        return data;
      }

      async function loadAll() {
        try {
          setStatus('正在加载管理后台...', '');
          var overview = await api('/admin/api/overview');
          renderOverview(overview);
          await loadConfig(false);
          await loadTasks(false);
          setStatus('已连接。最后刷新时间：' + new Date().toLocaleString(), 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      async function loadOverview() {
        try {
          setStatus('正在加载管理后台...', '');
          var data = await api('/admin/api/overview');
          renderOverview(data);
          setStatus('已连接。最后刷新时间：' + new Date().toLocaleString(), 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      async function loadConfig(showStatus) {
        try {
          var data = await api('/admin/api/config');
          currentConfigJson = data.config_json || '';
          currentConfigEl.textContent = currentConfigJson;
          exampleRequestEl.textContent = renderExampleRequest(data.example_chat_request);
          if (!configJsonEl.value.trim()) {
            configJsonEl.value = currentConfigJson;
          }
          if (showStatus !== false) {
            setStatus('配置已刷新。', 'ok');
          }
        } catch (error) {
          currentConfigEl.textContent = error.message || String(error);
          if (showStatus !== false) {
            setStatus(error.message || String(error), 'error');
          }
        }
      }

      async function loadTasks(showStatus) {
        var params = new URLSearchParams();
        var status = document.getElementById('task-status-filter').value;
        var query = document.getElementById('task-query').value.trim();
        var limit = document.getElementById('task-limit').value;
        params.set('limit', limit);
        if (status) {
          params.set('status', status);
        }
        if (query) {
          params.set('q', query);
        }

        try {
          var data = await api('/admin/api/tasks?' + params.toString());
          renderTasks(data.data || []);
          if (showStatus !== false) {
            setStatus('任务列表已刷新，共返回 ' + data.returned + ' 条。', 'ok');
          }
        } catch (error) {
          tasksEl.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(error.message || String(error)) + '</td></tr>';
          if (showStatus !== false) {
            setStatus(error.message || String(error), 'error');
          }
        }
      }

      async function lookupTask() {
        var taskId = document.getElementById('task-id').value.trim();
        if (!taskId) {
          taskOutputEl.textContent = '请先输入任务 ID。';
          return;
        }

        try {
          var data = await api('/admin/api/tasks/' + encodeURIComponent(taskId));
          taskOutputEl.textContent = JSON.stringify(data.task, null, 2);
        } catch (error) {
          taskOutputEl.textContent = error.message || String(error);
        }
      }

      async function validateConfig() {
        var configJson = configJsonEl.value;
        try {
          var data = await api('/admin/api/config/validate', {
            method: 'POST',
            body: JSON.stringify({ config_json: configJson })
          });
          configOutputEl.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          configOutputEl.textContent = error.message || String(error);
        }
      }

      function fillCurrentConfig() {
        configJsonEl.value = currentConfigJson;
        configOutputEl.textContent = '已填入当前配置，可直接校验或复制到 MODEL_CONFIG_JSON。';
      }

      async function handleProviderAction(event) {
        var button = event.target.closest('[data-provider-health]');
        if (!button) {
          return;
        }

        var providerId = button.getAttribute('data-provider-health');
        button.disabled = true;
        try {
          var data = await api('/admin/api/providers/' + encodeURIComponent(providerId) + '/health');
          await loadOverview();
          setStatus('Provider 检查完成：' + data.provider.name + ' / ' + providerStatusText(data.provider.status), data.provider.status === 'ok' ? 'ok' : 'error');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        } finally {
          button.disabled = false;
        }
      }

      async function handleTaskAction(event) {
        var viewButton = event.target.closest('[data-task-view]');
        var cancelButton = event.target.closest('[data-task-cancel]');
        if (viewButton) {
          document.getElementById('task-id').value = viewButton.getAttribute('data-task-view') || '';
          await lookupTask();
          return;
        }
        if (!cancelButton) {
          return;
        }

        var taskId = cancelButton.getAttribute('data-task-cancel') || '';
        if (!window.confirm('确定取消任务 ' + taskId + '？')) {
          return;
        }

        cancelButton.disabled = true;
        try {
          var data = await api('/admin/api/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
          taskOutputEl.textContent = JSON.stringify(data.task, null, 2);
          await loadTasks(false);
          setStatus('任务已取消：' + taskId, 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        } finally {
          cancelButton.disabled = false;
        }
      }

      function renderOverview(data) {
        statsEl.innerHTML = renderStat('模型总数', data.stats.models_total) +
          renderStat('启用模型', data.stats.models_active) +
          renderStat('路由总数', data.stats.routes_total) +
          renderStat('可用路由', data.stats.routes_configured) +
          renderStat('供应商', data.stats.providers_total) +
          renderStat('任务样本', data.stats.recent_tasks) +
          renderStat('运行中', data.stats.tasks_running) +
          renderStat('失败任务', data.stats.tasks_failed);

        gatewayMetaEl.innerHTML = renderMeta('认证模式', data.gateway.auth_mode) +
          renderMeta('配置来源', data.gateway.config_source) +
          renderMeta('任务存储', taskStoreText(data.gateway.task_store)) +
          renderMeta('后台会话', Math.round(data.gateway.admin_session_ttl_seconds / 3600) + ' 小时') +
          renderMeta('用户 API Key', data.gateway.dev_api_key_configured ? '已配置' : '未配置') +
          renderMeta('绑定资源', bindingsText(data.gateway));

        warningsEl.innerHTML = data.warnings.length
          ? data.warnings.map(function (warning) { return '<div class="warning">' + escapeHtml(warning) + '</div>'; }).join('')
          : '<span class="pill ok">暂无活跃告警</span>';

        featuresEl.innerHTML = data.feature_matrix.length
          ? data.feature_matrix.map(renderFeature).join('')
          : '<div><span>功能状态</span><strong>暂无数据</strong></div>';

        endpointsEl.innerHTML = data.endpoints.length
          ? data.endpoints.map(renderEndpoint).join('')
          : '<p class="empty">暂无接口信息。</p>';

        modelsEl.innerHTML = data.models.length
          ? data.models.map(renderModelRow).join('')
          : '<tr><td colspan="5" class="empty">尚未配置模型。</td></tr>';

        providersEl.innerHTML = data.providers.length
          ? data.providers.map(renderProvider).join('')
          : '<p class="empty">尚未注册供应商。</p>';

        tasksEl.innerHTML = data.recent_tasks.length
          ? data.recent_tasks.map(renderTaskRow).join('')
          : '<tr><td colspan="6" class="empty">暂无最近任务。</td></tr>';
      }

      function renderStat(label, value) {
        return '<div class="stat"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
      }

      function renderMeta(label, value) {
        return '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
      }

      function renderFeature(feature) {
        return '<div><span>' + escapeHtml(feature.name) + '</span><strong><span class="pill ' + featureStatusClass(feature.status) + '">' + escapeHtml(featureStatusText(feature.status)) + '</span> ' + escapeHtml(feature.detail) + '</strong></div>';
      }

      function renderEndpoint(endpoint) {
        return '<div class="panel"><div class="pill">' + escapeHtml(endpoint.method) + '</div><code>' + escapeHtml(endpoint.path) + '</code><div class="status">认证：' + escapeHtml(endpoint.auth) + '</div></div>';
      }

      function renderModelRow(model) {
        var routes = model.routes.map(function (route) {
          return '<span class="pill">' + escapeHtml(route.plugin_id + ' / ' + route.provider_model) + '</span>' +
            (route.selected ? '<span class="pill ok">当前路由</span>' : '') +
            '<span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? '凭证已配置' : '缺少凭证') + '</span>' +
            '<span class="pill">优先级 ' + escapeHtml(route.priority === null ? '无' : route.priority) + '</span>' +
            '<span class="pill ' + statusClass(route.status) + '">' + escapeHtml(statusText(route.status)) + '</span>';
        }).join('<br>');

        return '<tr>' +
          '<td><code>' + escapeHtml(model.alias) + '</code></td>' +
          '<td>' + escapeHtml(modalityText(model.modality)) + '</td>' +
          '<td><span class="pill ' + statusClass(model.status) + '">' + escapeHtml(statusText(model.status)) + '</span></td>' +
          '<td>' + yesNo(model.supports_stream) + '</td>' +
          '<td>' + routes + '</td>' +
          '</tr>';
      }

      function renderProvider(provider) {
        var caps = Object.keys(provider.capabilities || {}).map(function (name) {
          var capability = provider.capabilities[name];
          return '<span class="pill">' + escapeHtml(name + ': ' + capability.execution_mode) + '</span>';
        }).join('');
        var routes = provider.routes && provider.routes.length
          ? provider.routes.map(function (route) {
              return '<div class="status"><code>' + escapeHtml(route.model_alias) + '</code> -> ' + escapeHtml(route.provider_model) + ' <span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? '凭证已配置' : '缺少凭证') + '</span></div>';
            }).join('')
          : '<div class="status">当前没有模型路由使用该 Provider。</div>';

        return '<div class="panel">' +
          '<h3>' + escapeHtml(provider.name) + '</h3>' +
          '<div class="pill ' + providerStatusClass(provider.status) + '">' + escapeHtml(providerStatusText(provider.status)) + '</div>' +
          '<div class="pill">' + escapeHtml(provider.id) + '</div>' +
          '<div class="pill">v' + escapeHtml(provider.version) + '</div>' +
          '<div class="pill">路由 ' + escapeHtml(provider.routes_configured + '/' + provider.routes_active) + '</div>' +
          '<div style="margin-top: 8px;">' + caps + '</div>' +
          routes +
          '<div class="actions" style="margin-top: 10px;"><button class="secondary compact" type="button" data-provider-health="' + escapeHtml(provider.id) + '">检查 Provider</button></div>' +
          '</div>';
      }

      function renderTasks(tasks) {
        tasksEl.innerHTML = tasks.length
          ? tasks.map(renderTaskRow).join('')
          : '<tr><td colspan="6" class="empty">暂无匹配任务。</td></tr>';
      }

      function renderTaskRow(task) {
        var actions = '<button class="secondary compact" type="button" data-task-view="' + escapeHtml(task.id) + '">详情</button>';
        if (task.cancelable) {
          actions += '<button class="danger compact" type="button" data-task-cancel="' + escapeHtml(task.id) + '">取消</button>';
        }

        return '<tr>' +
          '<td><code>' + escapeHtml(task.id) + '</code></td>' +
          '<td>' + escapeHtml(taskTypeText(task.type)) + '</td>' +
          '<td>' + escapeHtml(task.model) + '</td>' +
          '<td><span class="pill ' + statusClass(task.status) + '">' + escapeHtml(statusText(task.status)) + '</span></td>' +
          '<td>' + escapeHtml(task.created_at) + '</td>' +
          '<td><div class="actions">' + actions + '</div></td>' +
          '</tr>';
      }

      function bindingsText(gateway) {
        return 'DB ' + yesNo(gateway.db_bound) + ', KV ' + yesNo(gateway.kv_bound) + ', Queue ' + yesNo(gateway.queue_bound) + ', R2 ' + yesNo(gateway.r2_bound);
      }

      function yesNo(value) {
        return value ? '已启用' : '未启用';
      }

      function taskStoreText(value) {
        if (value === 'kv') {
          return 'KV';
        }
        if (value === 'memory') {
          return '内存';
        }
        return value;
      }

      function modalityText(value) {
        if (value === 'text') {
          return '文本';
        }
        if (value === 'vision') {
          return '视觉';
        }
        if (value === 'audio') {
          return '音频';
        }
        return value;
      }

      function taskTypeText(value) {
        if (value === 'chat.completions') {
          return '聊天补全';
        }
        return value;
      }

      function statusText(status) {
        if (status === 'active') {
          return '启用';
        }
        if (status === 'succeeded') {
          return '成功';
        }
        if (status === 'running') {
          return '运行中';
        }
        if (status === 'queued') {
          return '排队中';
        }
        if (status === 'hidden') {
          return '隐藏';
        }
        if (status === 'disabled') {
          return '停用';
        }
        if (status === 'failed') {
          return '失败';
        }
        if (status === 'canceled') {
          return '已取消';
        }
        if (status === 'expired') {
          return '已过期';
        }
        return status;
      }

      function statusClass(status) {
        if (status === 'active' || status === 'succeeded' || status === 'running') {
          return 'ok';
        }
        if (status === 'queued' || status === 'hidden') {
          return 'warn';
        }
        if (status === 'disabled' || status === 'failed' || status === 'canceled' || status === 'expired') {
          return 'danger';
        }
        return '';
      }

      function providerStatusText(status) {
        if (status === 'ok') {
          return '可用';
        }
        if (status === 'warning') {
          return '未使用';
        }
        if (status === 'error') {
          return '异常';
        }
        return status;
      }

      function providerStatusClass(status) {
        if (status === 'ok') {
          return 'ok';
        }
        if (status === 'warning') {
          return 'warn';
        }
        if (status === 'error') {
          return 'danger';
        }
        return '';
      }

      function featureStatusText(status) {
        if (status === 'ready') {
          return '就绪';
        }
        if (status === 'partial') {
          return '部分可用';
        }
        if (status === 'planned') {
          return '待实现';
        }
        if (status === 'blocked') {
          return '阻塞';
        }
        return status;
      }

      function featureStatusClass(status) {
        if (status === 'ready') {
          return 'ok';
        }
        if (status === 'partial' || status === 'planned') {
          return 'warn';
        }
        if (status === 'blocked') {
          return 'danger';
        }
        return '';
      }

      function renderExampleRequest(request) {
        if (!request) {
          return '暂无可用示例。';
        }

        return [
          'curl -X ' + request.method + ' "' + location.origin + request.endpoint + '"',
          '  -H "Authorization: Bearer <DEV_API_KEY>"',
          '  -H "Content-Type: application/json"',
          "  -d '" + JSON.stringify(request.body, null, 2) + "'"
        ].join('\n');
      }

      function setStatus(message, kind) {
        statusEl.textContent = message;
        statusEl.className = 'status' + (kind ? ' ' + kind : '');
      }

      function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
    })();
  </script>
</body>
</html>`;
