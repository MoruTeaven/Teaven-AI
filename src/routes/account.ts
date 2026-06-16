import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_TTL_SECONDS,
  authenticateAccount,
  createAccountSession,
  findAccountUser,
  isAccountCenterConfigured,
  verifyAccountAccessToken
} from "../auth/account";
import { listModels, loadGatewayConfig } from "../config";
import { conflict, invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import {
  createAdminApiKey,
  createAdminUser,
  getAdminApiKey,
  listAdminApiKeys,
  listUsageRecords,
  saveAdminApiKey,
  saveAdminUser,
  type AdminApiKey,
  type AdminUser,
  type UsageRecord,
  type UsageSummary
} from "../admin/store";
import { getTask, listTasks, saveTask } from "../tasks/store";
import type { AsyncTaskRecord, Env } from "../types";
import { readJsonObject, requireString } from "../utils/request";

const DEFAULT_TASK_LIMIT = 50;
const MAX_TASK_LIMIT = 100;

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

    return htmlResponse(ACCOUNT_APP_HTML, {
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

  const taskCancelMatch = pathname.match(/^\/account\/api\/tasks\/([^/]+)\/cancel$/);
  if (request.method === "POST" && taskCancelMatch) {
    return handleCancelAccountTask(user, decodeURIComponent(taskCancelMatch[1]), env, requestId);
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
  const usage = summarizeUsage(usageRecords.filter((record) => record.tenant_id === user.tenant_id && userApiKeyIds.has(record.api_key_id)));
  const userTasks = tasks.filter((task) => task.tenant_id === user.tenant_id).slice(0, DEFAULT_TASK_LIMIT);
  const models = listModels(config)
    .filter((model) => model.status !== "disabled")
    .map((model) => ({
      id: model.alias,
      modality: model.modality,
      supports_stream: model.supports_stream !== false,
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
        durable: Boolean(env.AI_GATEWAY_KV),
        source: env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
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
      usage: summarizeUsage(usageRecords.filter((record) => record.tenant_id === user.tenant_id && userApiKeyIds.has(record.api_key_id)))
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
  const tasks = (await listTasks(env, MAX_TASK_LIMIT)).filter((task) => task.tenant_id === user.tenant_id).slice(0, limit);

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
    tenant_id: user.tenant_id,
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

async function handleCancelAccountTask(user: AdminUser, taskId: string, env: Env, requestId: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task || task.tenant_id !== user.tenant_id) {
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

async function listUserApiKeys(env: Env, user: AdminUser): Promise<AdminApiKey[]> {
  return (await listAdminApiKeys(env))
    .filter((apiKey) => apiKey.user_id === user.id && apiKey.tenant_id === user.tenant_id)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

async function requireOwnedApiKey(env: Env, user: AdminUser, apiKeyId: string): Promise<AdminApiKey> {
  const apiKey = await getAdminApiKey(env, apiKeyId);
  if (!apiKey || apiKey.user_id !== user.id || apiKey.tenant_id !== user.tenant_id) {
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
    tenant_id: user.tenant_id,
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
    tenant_id: apiKey.tenant_id,
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
    cancelable: isCancelableTask(task),
    store_output: task.store_output,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at || null,
    error: task.error || null
  };
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const ACCOUNT_APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teaven AI 用户中心</title>
  <style>
    :root { color-scheme: dark; --bg: #071012; --panel: rgba(15, 23, 42, 0.9); --panel-strong: #101827; --line: #263443; --text: #f8fafc; --muted: #94a3b8; --accent: #34d399; --accent-soft: rgba(52, 211, 153, 0.14); --warn: #f59e0b; --danger: #fb7185; --shadow: rgba(0, 0, 0, 0.28); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--text); background: radial-gradient(circle at top left, rgba(52, 211, 153, 0.18), transparent 28rem), radial-gradient(circle at 90% 10%, rgba(56, 189, 248, 0.12), transparent 24rem), var(--bg); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select { font: inherit; }
    button { border: 0; border-radius: 999px; background: var(--accent); color: #052e1d; cursor: pointer; font-weight: 900; padding: 10px 14px; }
    button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: rgba(251, 113, 133, 0.14); color: #fecdd3; border: 1px solid rgba(251, 113, 133, 0.36); }
    button.compact { padding: 7px 10px; font-size: 12px; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    input, select { width: 100%; color: var(--text); background: var(--panel-strong); border: 1px solid var(--line); border-radius: 12px; outline: none; padding: 10px 12px; }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.12); }
    .layout { width: min(1480px, 100%); margin: 0 auto; padding: 28px; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; margin-bottom: 20px; }
    .eyebrow { color: var(--accent); font-size: 11px; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase; }
    h1 { margin: 8px 0 0; font-size: clamp(36px, 6vw, 68px); letter-spacing: -0.07em; line-height: 0.92; }
    h2, h3, p { margin: 0; }
    .subtitle, .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; padding: 18px; box-shadow: 0 22px 72px var(--shadow); backdrop-filter: blur(18px); min-width: 0; }
    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-6 { grid-column: span 6; }
    .span-4 { grid-column: span 4; }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .stat { border: 1px solid var(--line); border-radius: 18px; padding: 14px; background: var(--panel-strong); }
    .stat strong { display: block; font-size: 26px; letter-spacing: -0.04em; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .full { grid-column: 1 / -1; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .list { display: grid; gap: 10px; }
    .item { border: 1px solid var(--line); background: var(--panel-strong); border-radius: 18px; padding: 14px; display: grid; gap: 10px; }
    .item header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; color: var(--muted); font-size: 13px; }
    .badge { display: inline-flex; align-items: center; width: max-content; border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .badge.active { color: #bbf7d0; border-color: rgba(52, 211, 153, 0.38); background: var(--accent-soft); }
    .badge.disabled, .badge.failed { color: #fecdd3; border-color: rgba(251, 113, 133, 0.38); background: rgba(251, 113, 133, 0.12); }
    .badge.queued, .badge.running { color: #fde68a; border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.12); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; }
    code { word-break: break-all; color: #bbf7d0; }
    .secret { display: none; margin-top: 12px; border: 1px solid rgba(52, 211, 153, 0.38); border-radius: 18px; background: rgba(52, 211, 153, 0.1); padding: 14px; }
    .notice { color: var(--muted); border: 1px dashed var(--line); border-radius: 18px; padding: 14px; background: rgba(148, 163, 184, 0.06); }
    @media (max-width: 980px) { .span-8, .span-6, .span-4 { grid-column: span 12; } .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .topbar { align-items: flex-start; flex-direction: column; } }
    @media (max-width: 640px) { .layout { padding: 18px; } .stats, .form-grid, .meta { grid-template-columns: 1fr; } .card { border-radius: 20px; } table { display: block; overflow-x: auto; white-space: nowrap; } }
  </style>
</head>
<body>
  <main class="layout">
    <header class="topbar">
      <div>
        <div class="eyebrow">Teaven AI Gateway</div>
        <h1>用户中心</h1>
        <p class="subtitle" id="subtitle">正在载入账户信息...</p>
      </div>
      <form action="/account/logout" method="post"><button class="secondary" type="submit">退出登录</button></form>
    </header>

    <section class="grid">
      <section class="card span-12">
        <div class="stats">
          <div class="stat"><span class="muted">API Key</span><strong id="statKeys">0</strong></div>
          <div class="stat"><span class="muted">请求数</span><strong id="statRequests">0</strong></div>
          <div class="stat"><span class="muted">Token</span><strong id="statTokens">0</strong></div>
          <div class="stat"><span class="muted">任务</span><strong id="statTasks">0</strong></div>
        </div>
      </section>

      <section class="card span-4">
        <div class="card-head"><div><h2>个人资料</h2><p class="muted">账户和租户信息</p></div></div>
        <form id="profileForm" class="form-grid">
          <label class="full">显示名称<input id="profileName" name="name" placeholder="可选"></label>
          <div class="full meta" id="profileMeta"></div>
          <button class="full" type="submit">保存资料</button>
        </form>
      </section>

      <section class="card span-8">
        <div class="card-head"><div><h2>创建 API Key</h2><p class="muted">密钥明文只展示一次</p></div></div>
        <form id="keyForm" class="form-grid">
          <label>名称<input id="keyName" name="name" value="默认密钥" required></label>
          <label>过期时间<input id="keyExpires" name="expires_at" type="datetime-local"></label>
          <label class="full">可用模型<select id="keyModels" name="allowed_models" multiple size="4"></select></label>
          <button type="submit">创建密钥</button>
          <button class="secondary" type="button" id="selectAllModels">使用全部模型</button>
        </form>
        <div id="secretBox" class="secret"></div>
      </section>

      <section class="card span-8">
        <div class="card-head"><div><h2>我的 API Key</h2><p class="muted">禁用后该密钥将无法调用接口</p></div></div>
        <div id="keyList" class="list"></div>
      </section>

      <section class="card span-4">
        <div class="card-head"><div><h2>可用模型</h2><p class="muted">创建密钥时可限制模型范围</p></div></div>
        <div id="modelList" class="list"></div>
      </section>

      <section class="card span-6">
        <div class="card-head"><div><h2>用量</h2><p class="muted">按模型聚合</p></div></div>
        <div id="usageTable"></div>
      </section>

      <section class="card span-6">
        <div class="card-head"><div><h2>最近任务</h2><p class="muted">仅展示当前租户任务</p></div></div>
        <div id="taskTable"></div>
      </section>
    </section>
  </main>

  <script>
    let state = null;
    const $ = (selector) => document.querySelector(selector);
    const fmt = new Intl.NumberFormat('zh-CN');

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

    function render() {
      const user = state.user;
      $('#subtitle').textContent = user.name ? user.name + ' · ' + user.email : user.email;
      $('#profileName').value = user.name || '';
      $('#profileMeta').innerHTML = '<span>用户 ID</span><code>' + escapeHtml(user.id) + '</code><span>租户 ID</span><code>' + escapeHtml(user.tenant_id) + '</code><span>角色</span><span>' + escapeHtml(user.role) + '</span><span>存储</span><span>' + escapeHtml(state.storage.source) + '</span>';
      $('#statKeys').textContent = fmt.format(state.api_keys.length);
      $('#statRequests').textContent = fmt.format(state.usage.total_requests);
      $('#statTokens').textContent = fmt.format(state.usage.total_tokens);
      $('#statTasks').textContent = fmt.format(state.tasks.length);
      renderModels();
      renderKeys();
      renderUsage();
      renderTasks();
    }

    function renderModels() {
      $('#keyModels').innerHTML = state.models.map((model) => '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.id) + ' · ' + escapeHtml(model.modality) + '</option>').join('');
      $('#modelList').innerHTML = state.models.length ? state.models.map((model) => '<div class="item"><header><strong>' + escapeHtml(model.id) + '</strong><span class="badge active">' + escapeHtml(model.modality) + '</span></header><span class="muted">流式：' + (model.supports_stream ? '支持' : '不支持') + '</span></div>').join('') : '<div class="notice">暂无可用模型。</div>';
    }

    function renderKeys() {
      $('#keyList').innerHTML = state.api_keys.length ? state.api_keys.map((key) => '<article class="item"><header><div><strong>' + escapeHtml(key.name) + '</strong><div class="muted"><code>' + escapeHtml(key.key_prefix) + '...</code></div></div><span class="badge ' + escapeHtml(key.status) + '">' + escapeHtml(key.status) + '</span></header><div class="meta"><span>模型</span><span>' + escapeHtml(key.allowed_models.length ? key.allowed_models.join(', ') : '全部模型') + '</span><span>过期</span><span>' + escapeHtml(key.expires_at || '永不过期') + '</span><span>最后使用</span><span>' + escapeHtml(key.last_used_at || '尚未使用') + '</span></div><div class="row"><button class="compact danger" data-disable-key="' + escapeHtml(key.id) + '" ' + (key.status === 'disabled' ? 'disabled' : '') + '>禁用</button></div></article>').join('') : '<div class="notice">还没有 API Key。创建第一个密钥后即可调用 /v1 接口。</div>';
    }

    function renderUsage() {
      const rows = state.usage.by_model.map((row) => '<tr><td>' + escapeHtml(row.model) + '</td><td>' + fmt.format(row.requests) + '</td><td>' + fmt.format(row.total_tokens) + '</td><td>' + fmt.format(row.media_count) + '</td></tr>').join('');
      $('#usageTable').innerHTML = rows ? '<table><thead><tr><th>模型</th><th>请求</th><th>Token</th><th>媒体</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="notice">暂无用量记录。</div>';
    }

    function renderTasks() {
      const rows = state.tasks.map((task) => '<tr><td><code>' + escapeHtml(task.id) + '</code></td><td>' + escapeHtml(task.model) + '</td><td><span class="badge ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span></td><td>' + escapeHtml(task.created_at) + '</td><td>' + (task.cancelable ? '<button class="compact danger" data-cancel-task="' + escapeHtml(task.id) + '">取消</button>' : '') + '</td></tr>').join('');
      $('#taskTable').innerHTML = rows ? '<table><thead><tr><th>任务</th><th>模型</th><th>状态</th><th>创建</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="notice">暂无任务。</div>';
    }

    $('#profileForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      await api('/account/api/profile', { method: 'PATCH', body: JSON.stringify({ name: $('#profileName').value }) });
      await load();
    });

    $('#keyForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const allowedModels = Array.from($('#keyModels').selectedOptions).map((option) => option.value);
      const expiresAt = $('#keyExpires').value ? new Date($('#keyExpires').value).toISOString() : null;
      const created = await api('/account/api/api-keys', { method: 'POST', body: JSON.stringify({ name: $('#keyName').value, allowed_models: allowedModels, expires_at: expiresAt }) });
      $('#secretBox').style.display = 'block';
      $('#secretBox').innerHTML = '<strong>密钥已创建，请立即复制：</strong><p><code>' + escapeHtml(created.secret) + '</code></p><button class="compact" id="copySecret">复制</button><p class="muted">' + escapeHtml(created.warning) + '</p>';
      $('#copySecret').addEventListener('click', () => navigator.clipboard?.writeText(created.secret));
      await load();
    });

    $('#selectAllModels').addEventListener('click', () => {
      Array.from($('#keyModels').options).forEach((option) => { option.selected = false; });
    });

    document.addEventListener('click', async (event) => {
      const disableKey = event.target.closest('[data-disable-key]');
      if (disableKey && confirm('确定禁用这个 API Key？')) {
        await api('/account/api/api-keys/' + encodeURIComponent(disableKey.dataset.disableKey), { method: 'DELETE' });
        await load();
      }
      const cancelTask = event.target.closest('[data-cancel-task]');
      if (cancelTask && confirm('确定取消这个任务？')) {
        await api('/account/api/tasks/' + encodeURIComponent(cancelTask.dataset.cancelTask) + '/cancel', { method: 'POST' });
        await load();
      }
    });

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }

    load().catch((error) => {
      document.body.innerHTML = '<main class="layout"><section class="card"><h1>载入失败</h1><p class="subtitle">' + escapeHtml(error.message) + '</p><p><a href="/account/login" style="color: var(--accent)">重新登录</a></p></section></main>';
    });
  </script>
</body>
</html>`;
