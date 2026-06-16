import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  authenticateAdmin,
  createAdminSession,
  verifyAdminPassword
} from "../auth/admin";
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_TTL_SECONDS,
  createAccountSession
} from "../auth/account";
import { listModels, listProviderRoutes, loadGatewayConfig, resetGatewayConfig, saveGatewayConfig, validateGatewayConfig } from "../config";
import { conflict, invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
// eslint-disable-next-line import/no-cycle -- admin.ts and account.ts share serialization helper
import { serializeAccountSessionCookie } from "./account";
import {
  type AdminApiKey,
  createAdminUser,
  getAdminApiKey,
  getAdminUser,
  listAdminApiKeys,
  listAdminUsers,
  revealAdminApiKeyToken,
  saveAdminApiKey,
  saveAdminUser,
  summarizeUsage
} from "../admin/store";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import type { ProviderPluginManifest } from "../providers/types";
import { getTask, listTasks, saveTask } from "../tasks/store";
import type {
  AsyncTaskRecord,
  AsyncTaskStatus,
  Env,
  GatewayConfig,
  ModelConfig,
  ProviderRouteConfig,
  UpstreamConfig,
  UpstreamModelConfig
} from "../types";
import { readJsonObject, requireString } from "../utils/request";
import { createId } from "../utils/ids";

const DEFAULT_TASK_LIMIT = 50;
const MAX_TASK_LIMIT = 100;

interface AdminModelMutation {
  upstream_id: string;
  model: UpstreamModelConfig;
}

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

    return htmlResponse(ADMIN_APP_HTML, {
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

  if (request.method === "GET" && pathname === "/admin/api/upstreams") {
    return handleListAdminUpstreams(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/upstreams") {
    return handleUpsertAdminUpstream(request, env, requestId);
  }

  const upstreamMatch = pathname.match(/^\/admin\/api\/upstreams\/([^/]+)$/);
  if (upstreamMatch) {
    const upstreamId = decodeURIComponent(upstreamMatch[1]);
    if (request.method === "PUT") {
      return handleUpsertAdminUpstream(request, env, requestId, upstreamId);
    }
    if (request.method === "DELETE") {
      return handleDeleteAdminUpstream(upstreamId, env, requestId);
    }
  }

  if (request.method === "POST" && pathname === "/admin/api/config/validate") {
    return handleValidateConfig(request, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/models") {
    return handleListAdminModels(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/models") {
    return handleUpsertAdminModel(request, env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/models/reset") {
    return handleResetAdminModels(env, requestId);
  }

  const modelMatch = pathname.match(/^\/admin\/api\/models\/([^/]+)$/);
  if (modelMatch) {
    const alias = decodeURIComponent(modelMatch[1]);
    if (request.method === "PUT") {
      return handleUpsertAdminModel(request, env, requestId, alias);
    }
    if (request.method === "DELETE") {
      return handleDeleteAdminModel(alias, env, requestId);
    }
  }

  if (request.method === "GET" && pathname === "/admin/api/users") {
    return handleListAdminUsers(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/users") {
    return handleCreateAdminUser(request, env, requestId);
  }

  const userMatch = pathname.match(/^\/admin\/api\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) {
    return handleUpdateAdminUser(decodeURIComponent(userMatch[1]), request, env, requestId);
  }

  const impersonateMatch = pathname.match(/^\/admin\/api\/users\/([^/]+)\/impersonate$/);
  if (request.method === "POST" && impersonateMatch) {
    return handleImpersonateUser(request, decodeURIComponent(impersonateMatch[1]), env, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/api-keys") {
    return handleListAdminApiKeys(env, requestId);
  }

  const apiKeyMatch = pathname.match(/^\/admin\/api\/api-keys\/([^/]+)$/);
  if (request.method === "PATCH" && apiKeyMatch) {
    return handleUpdateAdminApiKey(decodeURIComponent(apiKeyMatch[1]), request, env, requestId);
  }

  const apiKeyRevealMatch = pathname.match(/^\/admin\/api\/api-keys\/([^/]+)\/reveal$/);
  if (request.method === "POST" && apiKeyRevealMatch) {
    return handleRevealAdminApiKey(decodeURIComponent(apiKeyRevealMatch[1]), request, env, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/usage") {
    return handleAdminUsage(env, requestId);
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
  const config = await loadGatewayConfig(env);
  const registry = createProviderRegistry(env);
  const [tasks, users, apiKeys, usage] = await Promise.all([
    listTasks(env, MAX_TASK_LIMIT),
    listAdminUsers(env),
    listAdminApiKeys(env),
    summarizeUsage(env)
  ]);
  const models = listModels(config);
  const routeStats = summarizeRoutes(config, env);
  const taskStats = summarizeTasks(tasks);

  return jsonResponse(
    {
      status: "ok",
      generated_at: new Date().toISOString(),
      gateway: buildGatewayInfo(env),
      stats: {
        models_total: models.length,
        models_active: models.filter((model) => model.status !== "disabled").length,
        upstreams_total: config.upstreams.length,
        upstreams_active: config.upstreams.filter((upstream) => upstream.status !== "disabled").length,
        routes_total: routeStats.total,
        routes_active: routeStats.active,
        routes_configured: routeStats.configured,
        providers_total: registry.list().length,
        recent_tasks: tasks.length,
        tasks_running: taskStats.running,
        tasks_failed: taskStats.failed,
        users_total: users.length,
        api_keys_active: apiKeys.filter((apiKey) => apiKey.status === "active").length,
        usage_requests: usage.total_requests,
        usage_tokens: usage.total_tokens
      },
      task_stats: taskStats,
      usage_summary: usage,
      warnings: buildWarnings(env, config),
      upstreams: config.upstreams.map((upstream) => publicUpstream(upstream, config, env)),
      models: models.map((model) => publicModel(model, env)),
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
  const config = await loadGatewayConfig(env);
  const models = listModels(config);
  const routes = listProviderRoutes(config);

  return jsonResponse(
    {
      source: env.MODEL_CONFIG_JSON ? "MODEL_CONFIG_JSON" : "环境默认值",
      valid: true,
      config,
      config_json: JSON.stringify(config, null, 2),
      summary: {
        upstreams_total: config.upstreams.length,
        models_total: models.length,
        routes_total: routes.length,
        routes_configured: routes.filter((route) => isRouteCredentialConfigured(env, route)).length
      },
      example_chat_request: {
        endpoint: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: "Bearer <DEV_API_KEY>",
          "Content-Type": "application/json"
        },
        body: {
          model: models[0]?.alias || "gpt-4o-mini",
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

async function handleListAdminModels(env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  return jsonResponse(
    {
      object: "list",
      data: listModels(config).map((model) => publicModel(model, env))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleListAdminUpstreams(env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  return jsonResponse(
    {
      object: "list",
      data: config.upstreams.map((upstream) => publicUpstream(upstream, config, env))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpsertAdminUpstream(request: Request, env: Env, requestId: string, expectedId?: string): Promise<Response> {
  const body = await readJsonObject(request);
  const upstreamInput = normalizeUpstreamInput(body.upstream ?? body);
  if (expectedId && upstreamInput.id !== expectedId) {
    throw invalidRequest("上游 ID 不能与路径不一致", "id");
  }

  const config = await loadGatewayConfig(env);
  const existing = config.upstreams.find((upstream) => upstream.id === upstreamInput.id);
  const upstream: UpstreamConfig = {
    ...upstreamInput,
    models: existing?.models || []
  };
  const nextUpstreams = config.upstreams.filter((item) => item.id !== upstream.id);
  nextUpstreams.push(upstream);
  nextUpstreams.sort((left, right) => left.id.localeCompare(right.id));
  const nextConfig = { upstreams: nextUpstreams };
  await saveGatewayConfig(env, nextConfig);

  return jsonResponse(
    {
      upstream: publicUpstream(upstream, nextConfig, env),
      config_source: env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleDeleteAdminUpstream(upstreamId: string, env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  const upstream = config.upstreams.find((item) => item.id === upstreamId);
  if (!upstream) {
    throw notFound("上游不存在");
  }
  if (upstream.models.length > 0) {
    throw invalidRequest("上游下仍有模型，请先删除模型后再删除上游", "upstream_id");
  }
  if (config.upstreams.length === 1) {
    throw invalidRequest("至少需要保留一个上游");
  }

  await saveGatewayConfig(env, { upstreams: config.upstreams.filter((item) => item.id !== upstreamId) });
  return jsonResponse(
    {
      deleted: true,
      upstream_id: upstreamId
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpsertAdminModel(request: Request, env: Env, requestId: string, expectedAlias?: string): Promise<Response> {
  const body = await readJsonObject(request);
  const input = normalizeModelInput(body.model ?? body);
  if (expectedAlias && input.model.alias !== expectedAlias) {
    throw invalidRequest("模型别名不能与路径不一致", "alias");
  }

  const config = await loadGatewayConfig(env);
  const nextUpstreams = upsertUpstreamModel(config, input);
  const nextConfig = { upstreams: nextUpstreams };
  await saveGatewayConfig(env, nextConfig);
  const savedModel = listModels(nextConfig).find((model) => model.alias === input.model.alias) || {
    alias: input.model.alias,
    modality: input.model.modality,
    supports_stream: input.model.supports_stream,
    status: input.model.status,
    routes: []
  };

  return jsonResponse(
    {
      model: publicModel(savedModel, env),
      config_source: env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleDeleteAdminModel(alias: string, env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  let deleted = false;
  const nextUpstreams = config.upstreams.map((upstream) => {
      const models = upstream.models.filter((model) => model.alias !== alias);
      if (models.length !== upstream.models.length) {
        deleted = true;
      }
      return { ...upstream, models };
    });

  if (!deleted) {
    throw notFound("模型不存在");
  }

  await saveGatewayConfig(env, { upstreams: nextUpstreams });
  return jsonResponse(
    {
      deleted: true,
      alias
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleResetAdminModels(env: Env, requestId: string): Promise<Response> {
  await resetGatewayConfig(env);
  const config = await loadGatewayConfig(env);
  return jsonResponse(
    {
      reset: true,
      config,
      config_json: JSON.stringify(config, null, 2)
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleListAdminUsers(env: Env, requestId: string): Promise<Response> {
  const [users, apiKeys] = await Promise.all([listAdminUsers(env), listAdminApiKeys(env)]);
  return jsonResponse(
    {
      object: "list",
      users: users.sort((left, right) => right.created_at.localeCompare(left.created_at)),
      api_keys: apiKeys.map(publicApiKey).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleCreateAdminUser(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const email = requireString(body.email, "email");
  const user = await createAdminUser(env, {
    email,
    name: optionalBodyString(body.name, "name"),
    role: normalizeUserRole(body.role),
    status: normalizeUserStatus(body.status),
    organization_id: optionalBodyString(body.organization_id, "organization_id")
  });

  return jsonResponse(
    {
      user
    },
    {
      status: 201,
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpdateAdminUser(userId: string, request: Request, env: Env, requestId: string): Promise<Response> {
  const user = await getAdminUser(env, userId);
  if (!user) {
    throw notFound("用户不存在");
  }

  const body = await readJsonObject(request);
  if (body.email !== undefined) {
    user.email = requireString(body.email, "email");
  }
  if (body.name !== undefined) {
    user.name = optionalBodyString(body.name, "name");
  }
  if (body.role !== undefined) {
    user.role = normalizeUserRole(body.role);
  }
  if (body.status !== undefined) {
    user.status = normalizeUserStatus(body.status);
  }
  user.updated_at = new Date().toISOString();
  await saveAdminUser(env, user);

  return jsonResponse(
    {
      user
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleImpersonateUser(request: Request, userId: string, env: Env, requestId: string): Promise<Response> {
  const user = await getAdminUser(env, userId);
  if (!user) {
    throw notFound("用户不存在");
  }
  if (user.status !== "active") {
    throw invalidRequest("该用户已被禁用，无法模拟登录");
  }

  const session = await createAccountSession(env, user.id);

  return jsonResponse(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name || null,
        organization_id: user.organization_id
      },
      redirect: "/account"
    },
    {
      headers: {
        "Set-Cookie": serializeAccountSessionCookie(request, session, ACCOUNT_SESSION_TTL_SECONDS),
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleListAdminApiKeys(env: Env, requestId: string): Promise<Response> {
  const apiKeys = await listAdminApiKeys(env);
  return jsonResponse(
    {
      object: "list",
      data: apiKeys.map(publicApiKey).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpdateAdminApiKey(apiKeyId: string, request: Request, env: Env, requestId: string): Promise<Response> {
  const apiKey = await getAdminApiKey(env, apiKeyId);
  if (!apiKey) {
    throw notFound("接口密钥不存在");
  }

  const body = await readJsonObject(request);
  if (body.name !== undefined) {
    apiKey.name = requireString(body.name, "name");
  }
  if (body.status !== undefined) {
    apiKey.status = normalizeApiKeyStatus(body.status);
  }
  if (body.allowed_models !== undefined) {
    apiKey.allowed_models = normalizeAllowedModels(body.allowed_models);
  }
  if (body.expires_at !== undefined) {
    apiKey.expires_at = optionalBodyString(body.expires_at, "expires_at") || null;
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

async function handleRevealAdminApiKey(apiKeyId: string, request: Request, env: Env, requestId: string): Promise<Response> {
  const apiKey = await getAdminApiKey(env, apiKeyId);
  if (!apiKey) {
    throw notFound("接口密钥不存在");
  }

  const body = await readJsonObject(request);
  const password = requireString(body.password, "password");

  if (!(await verifyAdminPassword(password, env))) {
    throw invalidRequest("管理员密码不正确");
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

async function handleAdminUsage(env: Env, requestId: string): Promise<Response> {
  const usage = await summarizeUsage(env);
  return jsonResponse(
    {
      usage
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
  const config = await loadGatewayConfig(env);
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
        health.adapter_check = error instanceof Error ? error.message : "健康检查失败";
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
    const models = listModels(config);
    const routes = listProviderRoutes(config);

    return jsonResponse(
      {
        valid: true,
        upstreams_total: config.upstreams.length,
        models_total: models.length,
        routes_total: routes.length
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
      upstream_id: route.upstream_id,
      upstream_name: route.upstream_name || null,
      plugin_id: route.plugin_id,
      provider_model: route.provider_model,
      base_url_configured: Boolean(route.base_url),
      credential_id: route.credential_id || null,
      credential_configured: isRouteCredentialConfigured(env, route),
      modality: route.modality,
      supports_stream: route.supports_stream !== false,
      priority: route.priority ?? null,
      weight: route.weight ?? null,
      status: route.status || "active",
      selected: route === selectedRoute
    }))
  };
}

function publicUpstream(upstream: UpstreamConfig, config: GatewayConfig, env: Env): Record<string, unknown> {
  const routes = listProviderRoutes(config).filter((route) => route.upstream_id === upstream.id);
  const activeRoutes = routes.filter((route) => route.status !== "disabled");

  return {
    id: upstream.id,
    name: upstream.name || upstream.id,
    plugin_id: upstream.plugin_id,
    base_url: upstream.base_url || null,
    credential_id: upstream.credential_id || null,
    credential_configured: isCredentialIdConfigured(env, upstream.credential_id),
    status: upstream.status || "active",
    models_total: upstream.models.length,
    models_active: upstream.models.filter((model) => model.status !== "disabled").length,
    routes_active: activeRoutes.length,
    models: upstream.models.map((model) => ({
      alias: model.alias,
      provider_model: model.provider_model,
      modality: model.modality,
      supports_stream: model.supports_stream !== false,
      priority: model.priority ?? null,
      weight: model.weight ?? null,
      status: model.status || "active"
    }))
  };
}

function publicProvider(manifest: ProviderPluginManifest, config: GatewayConfig, env: Env): Record<string, unknown> {
  return buildProviderHealth(manifest, config, env);
}

function publicTaskSummary(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    organization_id: task.organization_id,
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

function normalizeUpstreamInput(value: unknown): Omit<UpstreamConfig, "models"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("upstream 必须是对象", "upstream");
  }
  return readUpstreamInput(value as Record<string, unknown>);
}

function normalizeModelInput(value: unknown): AdminModelMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("model 必须是对象", "model");
  }

  const input = value as Record<string, unknown>;
  const upstream_id = requireString(input.upstream_id, "upstream_id");
  const alias = requireString(input.alias, "alias");
  const provider_model = requireString(input.provider_model, "provider_model");
  const modality = requireString(input.modality, "modality");
  if (!["text", "image", "video", "file"].includes(modality)) {
    throw invalidRequest("模态必须是 text、image、video 或 file", "modality");
  }

  const model: UpstreamModelConfig = {
    alias,
    provider_model,
    modality: modality as UpstreamModelConfig["modality"],
    supports_stream: input.supports_stream !== false,
    priority: optionalNumber(input.priority, "priority"),
    weight: optionalNumber(input.weight, "weight"),
    status: normalizeModelStatus(input.status)
  };

  return { upstream_id, model };
}

function readUpstreamInput(input: Record<string, unknown>): Omit<UpstreamConfig, "models"> {
  const rawUpstream = input.upstream;
  const upstream = rawUpstream && typeof rawUpstream === "object" && !Array.isArray(rawUpstream)
    ? (rawUpstream as Record<string, unknown>)
    : input;

  const rawId = input.upstream_id ?? upstream.id;
  const id = typeof rawId === "string" && rawId.length > 0 ? rawId : createId("up");
  return {
    id,
    name: optionalBodyString(upstream.name, "upstream.name") || id,
    plugin_id: requireString(upstream.plugin_id, "plugin_id"),
    base_url: optionalBodyString(upstream.base_url, "base_url"),
    credential_id: optionalBodyString(upstream.credential_id, "credential_id"),
    config: optionalObject(upstream.config, "config"),
    status: normalizeUpstreamStatus(upstream.status)
  };
}

function upsertUpstreamModel(config: GatewayConfig, input: AdminModelMutation): UpstreamConfig[] {
  const upstreams = config.upstreams.map((upstream) => ({ ...upstream, models: [...upstream.models] }));
  const target = upstreams.find((upstream) => upstream.id === input.upstream_id);

  if (!target) {
    throw invalidRequest(`上游 ${input.upstream_id} 不存在，请先在上游管理中创建`, "upstream_id");
  }

  target.models = target.models.filter((model) => model.alias !== input.model.alias);
  target.models.push(input.model);
  target.models.sort((left, right) => left.alias.localeCompare(right.alias));
  upstreams.sort((left, right) => left.id.localeCompare(right.id));
  return upstreams;
}

function normalizeModelStatus(value: unknown): UpstreamModelConfig["status"] {
  if (value === undefined || value === null || value === "") {
    return "active";
  }
  if (value === "active" || value === "hidden" || value === "disabled") {
    return value;
  }
  throw invalidRequest("模型状态无效", "status");
}

function normalizeUpstreamStatus(value: unknown): UpstreamConfig["status"] {
  if (value === undefined || value === null || value === "") {
    return "active";
  }
  if (value === "active" || value === "disabled" || value === "degraded") {
    return value;
  }
  throw invalidRequest("上游状态无效", "status");
}

function normalizeUserRole(value: unknown): "owner" | "admin" | "member" {
  if (value === undefined || value === null || value === "") {
    return "member";
  }
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  throw invalidRequest("角色无效", "role");
}

function normalizeUserStatus(value: unknown): "active" | "disabled" {
  if (value === undefined || value === null || value === "") {
    return "active";
  }
  if (value === "active" || value === "disabled") {
    return value;
  }
  throw invalidRequest("用户状态无效", "status");
}

function normalizeApiKeyStatus(value: unknown): "active" | "disabled" | "expired" {
  if (value === "active" || value === "disabled" || value === "expired") {
    return value;
  }
  throw invalidRequest("接口密钥状态无效", "status");
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
  return models.length > 0 ? models : undefined;
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

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidRequest(`${name} 必须是数字`, name);
  }
  return value;
}

function optionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${name} 必须是对象`, name);
  }
  return value as Record<string, unknown>;
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
    admin_auth_configured: Boolean(env.ADMIN_TOKEN),
    user_center_auth_configured: Boolean(env.USER_CENTER_TOKEN || env.ADMIN_TOKEN)
  };
}

function buildWarnings(env: Env, config: GatewayConfig): string[] {
  const warnings: string[] = [];

  if (!env.ADMIN_TOKEN) {
    warnings.push("未配置 ADMIN_TOKEN，管理后台无法登录。");
  }
  if (!env.DEV_API_KEY && env.AUTH_MODE !== "none") {
    warnings.push("未配置 DEV_API_KEY，用户接口认证将失败。");
  }
  if (!env.USER_CENTER_TOKEN && !env.ADMIN_TOKEN) {
    warnings.push("未配置 USER_CENTER_TOKEN，用户中心无法登录。");
  }
  if (!env.AI_GATEWAY_KV) {
    warnings.push("未绑定 AI_GATEWAY_KV，后台保存的模型、用户、接口密钥、用量和任务记录仅保存在内存中。");
  }
  if (!env.DB) {
    warnings.push("未绑定 DB，租户、接口密钥、配额和计费管理尚无法持久化。");
  }
  if (!env.TASK_QUEUE) {
    warnings.push("未绑定 TASK_QUEUE，异步任务只会入库，不会被后台队列处理。");
  }
  if (!env.FILES) {
    warnings.push("未绑定 FILES，异步任务输出转存 R2 的能力尚不可用。");
  }

  for (const model of listModels(config)) {
    if (model.status === "disabled") {
      continue;
    }

    const activeRoutes = model.routes.filter((route) => route.status !== "disabled");
    if (activeRoutes.length === 0) {
      warnings.push(`模型 ${model.alias} 没有可用路由。`);
    }
    for (const route of activeRoutes) {
      if (!isRouteCredentialConfigured(env, route)) {
        warnings.push(`模型 ${model.alias} 在上游 ${route.upstream_id} 的 ${route.provider_model} 缺少 API Key。`);
      }
    }
  }

  return warnings;
}

function buildProviderHealth(manifest: ProviderPluginManifest, config: GatewayConfig, env: Env): Record<string, unknown> {
  const routes = listModels(config).flatMap((model) =>
    model.routes.filter((route) => route.plugin_id === manifest.id).map((route) => ({ model_alias: model.alias, route }))
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
      upstream_id: route.upstream_id,
      upstream_name: route.upstream_name || null,
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
      name: "上游模型路由",
      status: env.AI_GATEWAY_KV || env.MODEL_CONFIG_JSON ? "ready" : "partial",
      detail: env.AI_GATEWAY_KV ? "支持后台保存上游模型配置" : env.MODEL_CONFIG_JSON ? "使用 MODEL_CONFIG_JSON" : "使用默认单上游模型"
    },
    {
      name: "用户/接口密钥管理",
      status: env.AI_GATEWAY_KV ? "ready" : "partial",
      detail: env.AI_GATEWAY_KV ? "用户和接口密钥持久化到 KV" : "当前为内存存储，适合本地开发"
    },
    {
      name: "用户中心",
      status: env.USER_CENTER_TOKEN || env.ADMIN_TOKEN ? "ready" : "blocked",
      detail: env.USER_CENTER_TOKEN ? "USER_CENTER_TOKEN 已配置" : env.ADMIN_TOKEN ? "暂用 ADMIN_TOKEN 作为访问口令" : "需要 USER_CENTER_TOKEN"
    },
    {
      name: "模型用量统计",
      status: env.AI_GATEWAY_KV ? "ready" : "partial",
      detail: env.AI_GATEWAY_KV ? "用量记录持久化到 KV" : "当前为内存聚合"
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
      status: "planned",
      detail: env.DB ? "DB 已绑定，账单模型待实现" : "基础租户已随用户创建，账单仍待 D1 模型"
    }
  ];
}

function buildEndpointList(): Array<Record<string, string>> {
  return [
    { method: "GET", path: "/health", auth: "无" },
    { method: "GET", path: "/account", auth: "用户中心会话" },
    { method: "GET", path: "/account/api/profile", auth: "用户中心会话" },
    { method: "POST", path: "/account/api/api-keys", auth: "用户中心会话" },
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

  for (const route of listProviderRoutes(config)) {
    total += 1;
    if (route.status !== "disabled") {
      active += 1;
    }
    if (route.status !== "disabled" && isRouteCredentialConfigured(env, route)) {
      configured += 1;
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
    if (query && !`${task.id} ${task.organization_id} ${task.api_key_id} ${task.model} ${task.type}`.toLowerCase().includes(query)) {
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
  for (const route of listProviderRoutes(config)) {
    if (route.plugin_id === pluginId && route.status !== "disabled" && isRouteCredentialConfigured(env, route)) {
      return route;
    }
  }

  return undefined;
}

function isRouteCredentialConfigured(env: Env | undefined, route: ProviderRouteConfig): boolean {
  if (!env) {
    return false;
  }
  return isCredentialIdConfigured(env, route.credential_id);
}

function isCredentialIdConfigured(env: Env | undefined, credentialId: string | undefined): boolean {
  if (!credentialId) {
    return false;
  }

  // env: 前缀 → 检查对应的环境变量 / Secret 是否已配置
  if (credentialId.startsWith("env:")) {
    if (!env) return false;
    const secretName = credentialId.slice(4);
    const value = (env as unknown as Record<string, unknown>)[secretName];
    return typeof value === "string" && value.length > 0;
  }

  // 无 env: 前缀 → 直接作为 API Key 使用，非空即为已配置
  return credentialId.length > 0;
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

const ADMIN_APP_HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teaven AI 管理后台</title>
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
      color: white;
      cursor: pointer;
      font-weight: 800;
      padding: 10px 14px;
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
    textarea { min-height: 180px; resize: vertical; font-family: Consolas, "SFMono-Regular", monospace; font-size: 13px; line-height: 1.5; }
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
    .nav a.active, .nav a:hover { color: var(--text); background: rgba(125, 211, 252, 0.13); }
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
    .span-7 { grid-column: span 7; }
    .span-6 { grid-column: span 6; }
    .span-5 { grid-column: span 5; }
    .span-4 { grid-column: span 4; }
    .card h3 { margin: 0 0 12px; font-size: 17px; }
    .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
    .card-head h3 { margin-bottom: 6px; }
    .entity-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
    .entity-card {
      display: grid;
      gap: 12px;
      min-width: 0;
      padding: 16px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 18px;
    }
    .entity-card:hover { border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); }
    .entity-card header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
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
    .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .stat { padding: 15px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; }
    .stat strong { display: block; font-size: 28px; letter-spacing: -0.04em; }
    .stat span, label { color: var(--muted); font-size: 12px; font-weight: 800; }
    .form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .form-grid label { display: grid; gap: 6px; }
    .stack { display: grid; gap: 10px; }
    .status { color: var(--muted); font-size: 13px; min-height: 20px; }
    .status.ok { color: var(--ok); }
    .status.error { color: var(--danger); }
    .pill { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); font-size: 12px; margin: 2px 4px 2px 0; }
    .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
    .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
    .pill.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
    .warning { padding: 11px 12px; border-radius: 14px; color: var(--warn); background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.28); }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 8px; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    code, pre { font-family: Consolas, "SFMono-Regular", monospace; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .json-view { max-height: 360px; overflow: auto; padding: 14px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; color: var(--text); font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .empty { color: var(--muted); padding: 12px 0; }
    .secret { border: 1px solid rgba(125, 211, 252, 0.38); border-radius: 18px; background: rgba(125, 211, 252, 0.1); padding: 14px; }
    .alert { border: 1px solid rgba(251, 113, 133, 0.35); border-radius: 16px; background: rgba(251, 113, 133, 0.1); color: #fecdd3; padding: 12px 14px; font-size: 13px; }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal.open { display: flex; }
    .modal-backdrop { position: absolute; inset: 0; background: rgba(2, 6, 23, 0.72); backdrop-filter: blur(10px); }
    .modal-card {
      position: relative;
      z-index: 1;
      width: min(860px, 100%);
      max-height: calc(100vh - 40px);
      overflow: auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.42);
      padding: 20px;
    }
    .modal-card.narrow { width: min(560px, 100%); }
    .modal-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
    .modal-head h3 { margin: 4px 0 0; font-size: 22px; }
    .modal-form { margin-top: 0; }
    .form-grid.single { grid-template-columns: 1fr; }
    body.modal-open { overflow: hidden; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; }
      .content { padding: 18px; }
      .topbar { display: grid; }
      .toolbar { justify-content: flex-start; }
      .stat-grid, .form-grid { grid-template-columns: 1fr; }
      .card-head, .modal-head { display: grid; }
      .card-head button, .modal-head button { width: 100%; }
      .entity-row { grid-template-columns: 1fr; gap: 4px; }
      .modal { padding: 12px; }
      .modal-card { max-height: calc(100vh - 24px); padding: 16px; }
      .span-4, .span-5, .span-6, .span-7, .span-8, .span-12 { grid-column: span 12; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <div class="eyebrow">Teaven AI Gateway</div>
        <h1>管理后台</h1>
        <p class="subtitle">模型、用户、用量与运行状态。</p>
      </div>
      <nav class="nav" id="nav">
        <a href="#dashboard" data-section="dashboard">仪表盘</a>
        <a href="#upstreams" data-section="upstreams">上游管理</a>
        <a href="#models" data-section="models">模型管理</a>
        <a href="#users" data-section="users">用户管理</a>
        <a href="#usage" data-section="usage">模型用量</a>
        <a href="#tasks" data-section="tasks">任务管理</a>
        <a href="#config" data-section="config">配置工具</a>
      </nav>
      <div class="sidebar-footer">
        <button id="theme-toggle" class="secondary" type="button">切换浅色</button>
        <form action="/admin/logout" method="post"><button class="secondary" type="submit" style="width: 100%;">退出登录</button></form>
      </div>
    </aside>
    <main class="content">
      <div class="topbar">
        <div>
          <h2 id="page-title">仪表盘</h2>
          <p id="status" class="subtitle">正在加载管理后台...</p>
        </div>
        <div class="toolbar">
          <button id="refresh" class="secondary" type="button">刷新全部</button>
        </div>
      </div>

      <section id="dashboard" class="section active">
        <div class="grid">
          <div class="card span-12"><h3>核心指标</h3><div id="stats" class="stat-grid"></div></div>
          <div class="card span-8"><h3>功能状态</h3><div id="features" class="stack"></div></div>
          <div class="card span-4"><h3>告警</h3><div id="warnings" class="stack"></div></div>
          <div class="card span-6"><h3>网关状态</h3><div id="gateway-meta" class="stack"></div></div>
          <div class="card span-6"><h3>供应商</h3><div id="providers" class="stack"></div></div>
          <div class="card span-12"><h3>上游配置</h3><div id="dashboard-upstreams" class="stack"></div></div>
        </div>
      </section>

      <section id="upstreams" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head">
              <div>
                <h3>上游列表</h3>
                <p class="subtitle">先配置上游的类型、基础地址和 API Key，再到模型管理里把模型添加到上游。</p>
              </div>
              <button id="open-upstream-modal" type="button">添加上游</button>
            </div>
            <div id="upstreams-list" class="entity-grid"></div>
          </div>
        </div>
      </section>

      <section id="models" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head">
              <div>
                <h3>模型列表</h3>
                <p class="subtitle">模型挂载到已有上游下，继承上游的插件、域名和 API Key。</p>
              </div>
              <button id="open-model-modal" type="button">添加模型</button>
            </div>
            <div id="models-list" class="entity-grid"></div>
          </div>
          <div class="card span-12">
            <h3>模型 JSON 编辑器</h3>
            <textarea id="model-json" spellcheck="false"></textarea>
            <div class="actions" style="margin-top: 12px;"><button id="save-model-json" type="button">保存 JSON 模型</button><button id="reset-models" class="danger" type="button">重置模型配置</button></div>
          </div>
        </div>
      </section>

      <section id="users" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head">
              <div>
                <h3>用户列表</h3>
                <p class="subtitle">以卡片方式管理后台用户，可快速启用或禁用账号。</p>
              </div>
              <button id="open-user-modal" type="button">添加用户</button>
            </div>
            <div id="users-list" class="entity-grid"></div>
          </div>
          <div class="card span-12"><h3>接口密钥列表</h3><p class="subtitle">接口密钥由用户中心创建；管理后台只负责查看、启用、禁用和调整模型权限。</p><div id="keys-list" class="entity-grid"></div></div>
        </div>
      </section>

      <section id="usage" class="section">
        <div class="grid">
          <div class="card span-12"><h3>用量汇总</h3><div id="usage-stats" class="stat-grid"></div></div>
          <div class="card span-7"><h3>按模型统计</h3><div class="table-wrap"><table><thead><tr><th>模型</th><th>总请求数</th><th>Total Token</th><th>Input Token</th><th>Output Token</th><th>媒体单位</th></tr></thead><tbody id="usage-models"></tbody></table></div></div>
          <div class="card span-5"><h3>最近用量记录</h3><div id="usage-recent" class="stack"></div></div>
        </div>
      </section>

      <section id="tasks" class="section">
        <div class="grid">
          <div class="card span-12">
            <h3>异步任务</h3>
            <div class="form-grid">
              <label>状态<select id="task-status"><option value="">全部</option><option value="queued">排队中</option><option value="running">运行中</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="canceled">已取消</option><option value="expired">已过期</option></select></label>
              <label>关键词<input id="task-query" placeholder="任务 ID / 模型 / 租户"></label>
              <label>数量<select id="task-limit"><option value="25">25</option><option value="50" selected>50</option><option value="100">100</option></select></label>
            </div>
            <div class="actions" style="margin-top: 12px;"><button id="load-tasks" type="button">加载任务</button></div>
            <div class="table-wrap"><table><thead><tr><th>ID</th><th>类型</th><th>模型</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="tasks-table"></tbody></table></div>
          </div>
          <div class="card span-12"><h3>任务详情</h3><pre id="task-detail" class="json-view">选择任务后显示详情。</pre></div>
        </div>
      </section>

      <section id="config" class="section">
        <div class="grid">
          <div class="card span-6"><h3>当前网关配置</h3><pre id="current-config" class="json-view">正在加载...</pre></div>
          <div class="card span-6"><h3>接口调用示例</h3><pre id="example-request" class="json-view">正在加载...</pre></div>
          <div class="card span-12"><h3>模型配置 JSON 校验器</h3><textarea id="config-json" spellcheck="false"></textarea><div class="actions" style="margin-top: 12px;"><button id="fill-current-config" class="secondary" type="button">填入当前配置</button><button id="validate-config" type="button">校验</button></div><pre id="config-output" class="json-view" style="margin-top: 12px;">尚未执行校验。</pre></div>
        </div>
      </section>
    </main>
    <div id="upstream-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="upstream-modal-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">上游</div>
            <h3 id="upstream-modal-title">添加上游</h3>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div class="form-grid modal-form">
          <input id="upstream-admin-id" type="hidden">
          <label>上游名称<input id="upstream-admin-name" value="OpenAI Compatible Default"></label>
          <label>类型<select id="upstream-admin-plugin"></select></label>
          <label>基础地址<input id="upstream-admin-base-url" value="https://api.openai.com/v1"></label>
          <label>API Key<input id="upstream-admin-credential" value="env:OPENAI_COMPATIBLE_API_KEY" placeholder="env:MY_SECRET 或直接填写 sk-..."></label>
          <label>状态<select id="upstream-admin-status"><option value="active">启用</option><option value="degraded">降级</option><option value="disabled">停用</option></select></label>
        </div>
        <div class="actions" style="margin-top: 14px;"><button id="save-upstream-form" type="button">保存上游</button><button id="reset-upstream-form" class="secondary" type="button">清空表单</button></div>
      </section>
    </div>
    <div id="upstream-view-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="upstream-view-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">上游详情</div>
            <h3 id="upstream-view-title">查看上游</h3>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div id="upstream-view-content" class="stack"></div>
        <pre id="upstream-view-json" class="json-view" style="margin-top: 14px;"></pre>
      </section>
    </div>
    <div id="model-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="model-modal-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">模型</div>
            <h3 id="model-modal-title">添加模型</h3>
            <p class="subtitle">如需新上游，请先到上游管理创建。</p>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div class="form-grid modal-form">
          <label>模型别名<input id="model-alias" placeholder="gpt-4o-mini"></label>
          <label>上游模型名<input id="route-provider-model" placeholder="gpt-4o-mini"></label>
          <label>模态<select id="model-modality"><option value="text">文本</option><option value="image">图片</option><option value="video">视频</option><option value="file">文件</option></select></label>
          <label>模型状态<select id="model-status"><option value="active">启用</option><option value="hidden">隐藏</option><option value="disabled">停用</option></select></label>
          <label>流式<select id="model-stream"><option value="true">支持</option><option value="false">不支持</option></select></label>
          <label>优先级<input id="route-priority" type="number" value="1"></label>
          <label>所属上游<select id="model-upstream-select"></select></label>
        </div>
        <div class="actions" style="margin-top: 14px;"><button id="save-model-form" type="button">保存模型</button></div>
      </section>
    </div>
    <div id="user-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card narrow" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">用户</div>
            <h3 id="user-modal-title">添加用户</h3>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div class="form-grid single modal-form">
          <label>邮箱<input id="user-email" placeholder="admin@example.com"></label>
          <label>名称<input id="user-name" placeholder="管理员"></label>
          <label>角色<select id="user-role"><option value="owner">所有者</option><option value="admin">管理员</option><option value="member" selected>成员</option></select></label>
        </div>
        <div class="actions" style="margin-top: 14px;"><button id="create-user" type="button">创建用户</button></div>
      </section>
    </div>
    <div id="key-reveal-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card narrow" role="dialog" aria-modal="true" aria-labelledby="key-reveal-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">安全验证</div>
            <h3 id="key-reveal-title">查看密钥明文</h3>
            <p class="subtitle">请再次输入管理员密码以验证身份。</p>
          </div>
          <button class="secondary compact" type="button" data-modal-close>取消</button>
        </div>
        <div class="form-grid single modal-form">
          <label>管理员密码<input id="reveal-password" type="password" placeholder="请输入管理员密码" autocomplete="current-password"></label>
        </div>
        <div id="reveal-error" class="alert" style="display:none;"></div>
        <div id="reveal-result" class="secret" style="display:none; margin-top: 14px;"></div>
        <div class="actions" style="margin-top: 14px;"><button id="reveal-key-confirm" type="button">验证并查看</button></div>
      </section>
    </div>
  </div>
  <script>
    (function () {
      var state = { overview: null, config: null, models: [], users: [], apiKeys: [], usage: null, tasks: [] };
      var titles = { dashboard: '仪表盘', upstreams: '上游管理', models: '模型管理', users: '用户管理', usage: '模型用量', tasks: '任务管理', config: '配置工具' };
      var statusEl = document.getElementById('status');
      var theme = localStorage.getItem('teaven_admin_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      document.getElementById('theme-toggle').textContent = theme === 'dark' ? '切换浅色' : '切换深色';

      document.getElementById('nav').addEventListener('click', function (event) {
        var link = event.target.closest('[data-section]');
        if (!link) return;
        showSection(link.getAttribute('data-section'));
      });
      document.querySelectorAll('[data-modal-close]').forEach(function (button) {
        button.addEventListener('click', function (event) {
          var modal = event.target.closest('.modal');
          if (modal) closeModal(modal.id);
        });
      });
      document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeModal(); });
      document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
      document.getElementById('refresh').addEventListener('click', loadAll);
      document.getElementById('open-upstream-modal').addEventListener('click', function () { resetUpstreamForm(); openModal('upstream-modal', 'upstream-modal-title', '添加上游'); });
      document.getElementById('open-model-modal').addEventListener('click', function () { resetModelForm(); openModal('model-modal', 'model-modal-title', '添加模型'); });
      document.getElementById('open-user-modal').addEventListener('click', function () { resetUserForm(); openModal('user-modal', 'user-modal-title', '添加用户'); });
      document.getElementById('save-model-form').addEventListener('click', saveModelFromForm);
      document.getElementById('save-model-json').addEventListener('click', saveModelFromJson);
      document.getElementById('reset-models').addEventListener('click', resetModels);
      document.getElementById('save-upstream-form').addEventListener('click', saveUpstreamFromForm);
      document.getElementById('reset-upstream-form').addEventListener('click', resetUpstreamForm);
      document.getElementById('create-user').addEventListener('click', createUser);
      document.getElementById('reveal-key-confirm').addEventListener('click', revealApiKey);
      document.getElementById('load-tasks').addEventListener('click', loadTasks);
      document.getElementById('fill-current-config').addEventListener('click', fillCurrentConfig);
      document.getElementById('validate-config').addEventListener('click', validateConfig);
      document.getElementById('models-list').addEventListener('click', handleModelAction);
      document.getElementById('upstreams-list').addEventListener('click', handleUpstreamAction);
      document.getElementById('users-list').addEventListener('click', handleUserAction);
      document.getElementById('keys-list').addEventListener('click', handleKeyAction);
      document.getElementById('tasks-table').addEventListener('click', handleTaskAction);

      showSection((location.hash || '#dashboard').slice(1));
      loadAll();

      async function api(path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        var response = await fetch(path, Object.assign({}, options, { headers: headers, credentials: 'same-origin' }));
        var data = await response.json().catch(function () { return {}; });
        if (response.status === 401) {
          location.assign('/admin/login');
          throw new Error('登录已过期，请重新登录。');
        }
        if (!response.ok) {
          throw new Error(data.error && data.error.message ? data.error.message : '请求失败：' + response.status);
        }
        return data;
      }

      async function loadAll() {
        try {
          setStatus('正在刷新...', '');
          var results = await Promise.all([api('/admin/api/overview'), api('/admin/api/config'), api('/admin/api/models'), api('/admin/api/users'), api('/admin/api/usage'), api('/admin/api/tasks?limit=50')]);
          state.overview = results[0];
          state.config = results[1];
          state.models = results[2].data || [];
          state.users = results[3].users || [];
          state.apiKeys = results[3].api_keys || [];
          state.usage = results[4].usage;
          state.tasks = results[5].data || [];
          renderAll();
          setStatus('已刷新：' + new Date().toLocaleString(), 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      function renderAll() {
        renderDashboard();
        renderUpstreamManagement();
        renderModels();
        renderUsers();
        renderUsage();
        renderTasks(state.tasks);
        renderConfig();
      }

      function renderDashboard() {
        var data = state.overview || { stats: {}, warnings: [], feature_matrix: [], providers: [], upstreams: [], gateway: {} };
        document.getElementById('stats').innerHTML = stat('模型', data.stats.models_total) + stat('上游', data.stats.upstreams_total) + stat('用户', data.stats.users_total) + stat('活跃密钥', data.stats.api_keys_active) + stat('请求数', data.stats.usage_requests) + stat('Token', data.stats.usage_tokens) + stat('任务', data.stats.recent_tasks) + stat('供应商', data.stats.providers_total) + stat('失败任务', data.stats.tasks_failed);
        document.getElementById('warnings').innerHTML = data.warnings.length ? data.warnings.map(function (item) { return '<div class="warning">' + esc(item) + '</div>'; }).join('') : '<span class="pill ok">暂无活跃告警</span>';
        document.getElementById('features').innerHTML = data.feature_matrix.map(function (item) { return '<div><span class="pill ' + featureClass(item.status) + '">' + esc(featureText(item.status)) + '</span><strong>' + esc(item.name) + '</strong><div class="status">' + esc(item.detail) + '</div></div>'; }).join('');
        document.getElementById('gateway-meta').innerHTML = meta('认证模式', data.gateway.auth_mode) + meta('配置来源', data.gateway.config_source) + meta('任务存储', taskStoreText(data.gateway.task_store)) + meta('绑定资源', '数据库 ' + yesNo(data.gateway.db_bound) + ', KV ' + yesNo(data.gateway.kv_bound) + ', 队列 ' + yesNo(data.gateway.queue_bound) + ', R2 ' + yesNo(data.gateway.r2_bound));
        document.getElementById('providers').innerHTML = data.providers.map(function (provider) { return '<div><span class="pill ' + providerClass(provider.status) + '">' + esc(providerText(provider.status)) + '</span><strong>' + esc(provider.name) + '</strong><div class="status">' + esc(provider.id) + ' · 路由 ' + esc(provider.routes_configured + '/' + provider.routes_active) + '</div></div>'; }).join('') || '<div class="empty">暂无供应商。</div>';
        document.getElementById('dashboard-upstreams').innerHTML = renderUpstreams(data.upstreams || []);
      }

      function renderUpstreamManagement() {
        var upstreams = (state.overview && state.overview.upstreams) || [];
        var providers = (state.overview && state.overview.providers) || [];
        populatePluginSelect();
        var list = document.getElementById('upstreams-list');
        list.innerHTML = upstreams.length ? upstreams.map(function (upstream) {
          var deleteDisabled = upstream.models_total > 0 ? ' disabled title="请先删除该上游下的模型"' : '';
          var plugin = findProvider(providers, upstream.plugin_id);
          var modelPills = (upstream.models || []).slice(0, 4).map(function (model) { return '<span class="pill">' + esc(model.alias + ' -> ' + model.provider_model) + '</span>'; }).join('');
          if ((upstream.models || []).length > 4) modelPills += '<span class="pill">+' + esc(upstream.models.length - 4) + '</span>';
          if (!modelPills) modelPills = '<span class="status">暂无模型</span>';
          return '<article class="entity-card">' +
            '<header><div class="entity-title"><strong>' + esc(upstream.name || upstream.id) + '</strong><div class="status"><code>' + esc(upstream.id) + '</code></div></div><span class="pill ' + statusClass(upstream.status) + '">' + esc(statusText(upstream.status)) + '</span></header>' +
            '<div class="entity-meta">' +
              '<div class="entity-row"><span>类型</span><strong>' + esc(plugin ? plugin.name : upstream.plugin_id) + '</strong></div>' +
              '<div class="entity-row"><span>基础地址</span><code>' + esc(upstream.base_url || '未配置') + '</code></div>' +
              '<div class="entity-row"><span>API Key</span><div><code>' + esc(upstream.credential_id || '未配置') + '</code><br><span class="pill ' + (upstream.credential_configured ? 'ok' : 'danger') + '">' + (upstream.credential_configured ? '已配置' : '缺少') + '</span></div></div>' +
              '<div class="entity-row"><span>模型</span><div><strong>' + esc(upstream.models_active + '/' + upstream.models_total) + '</strong><div>' + modelPills + '</div></div></div>' +
            '</div>' +
            '<div class="actions entity-actions"><button type="button" class="secondary compact" data-upstream-view="' + esc(upstream.id) + '">查看</button><button type="button" class="secondary compact" data-upstream-edit="' + esc(upstream.id) + '">编辑</button><button type="button" class="danger compact" data-upstream-delete="' + esc(upstream.id) + '"' + deleteDisabled + '>删除</button></div>' +
          '</article>';
        }).join('') : '<div class="empty">暂无上游配置。</div>';
      }

      function populateUpstreamSelect() {
        var select = document.getElementById('model-upstream-select');
        var upstreams = (state.overview && state.overview.upstreams) || [];
        var providers = (state.overview && state.overview.providers) || [];
        select.innerHTML = upstreams.length ? '<option value="">-- 选择上游 --</option>' + upstreams.map(function (u) { var plugin = findProvider(providers, u.plugin_id); return '<option value="' + esc(u.id) + '">' + esc(u.name || u.id) + ' (' + esc(plugin ? plugin.name : u.plugin_id) + ')</option>'; }).join('') : '<option value="">-- 暂无上游，请先创建 --</option>';
      }

      function populatePluginSelect() {
        var select = document.getElementById('upstream-admin-plugin');
        var providers = (state.overview && state.overview.providers) || [];
        select.innerHTML = providers.length ? providers.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.id) + ')</option>'; }).join('') : '<option value="">-- 无可用插件 --</option>';
      }

      function renderModels() {
        var list = document.getElementById('models-list');
        var providers = (state.overview && state.overview.providers) || [];
        var modelUpstreams = document.getElementById('model-upstreams');
        if (modelUpstreams) modelUpstreams.innerHTML = renderUpstreams((state.overview && state.overview.upstreams) || []);
        populateUpstreamSelect();
        populatePluginSelect();
        list.innerHTML = state.models.length ? state.models.map(function (model) {
          var routes = (model.routes || []).map(function (route) {
            var plugin = findProvider(providers, route.plugin_id);
            return '<div><span class="pill">' + esc((route.upstream_name || route.upstream_id || '未配置') + ' / ' + route.provider_model) + '</span><span class="pill">' + esc(plugin ? plugin.name : route.plugin_id) + '</span><span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? 'Key 已配置' : '缺少 Key') + '</span><span class="pill ' + statusClass(route.status) + '">' + esc(statusText(route.status)) + '</span></div>';
          }).join('') || '<span class="status">暂无路由</span>';
          return '<article class="entity-card">' +
            '<header><div class="entity-title"><code>' + esc(model.alias) + '</code><div class="status">上游路由 ' + esc((model.routes || []).length) + ' 条</div></div><span class="pill ' + statusClass(model.status) + '">' + esc(statusText(model.status)) + '</span></header>' +
            '<div class="entity-meta">' +
              '<div class="entity-row"><span>模态</span><strong>' + esc(modalityText(model.modality)) + '</strong></div>' +
              '<div class="entity-row"><span>流式</span><strong>' + (model.supports_stream !== false ? '支持' : '不支持') + '</strong></div>' +
              '<div class="entity-row"><span>路由</span><div>' + routes + '</div></div>' +
            '</div>' +
            '<div class="actions entity-actions"><button type="button" class="secondary compact" data-model-edit="' + esc(model.alias) + '">编辑</button><button type="button" class="danger compact" data-model-delete="' + esc(model.alias) + '">删除</button></div>' +
          '</article>';
        }).join('') : '<div class="empty">暂无模型。</div>';
        if (state.models[0] && !document.getElementById('model-json').value.trim()) fillModelEditor(state.models[0].alias);
      }

      function renderUpstreams(upstreams) {
        var providers = (state.overview && state.overview.providers) || [];
        return upstreams.length ? upstreams.map(function (upstream) {
          var plugin = findProvider(providers, upstream.plugin_id);
          var models = (upstream.models || []).map(function (model) {
            return '<span class="pill">' + esc(model.alias + ' -> ' + model.provider_model) + '</span>';
          }).join('');
          return '<div>' +
            '<span class="pill ' + statusClass(upstream.status) + '">' + esc(statusText(upstream.status)) + '</span>' +
            '<strong>' + esc(upstream.name || upstream.id) + '</strong>' +
            '<div class="status">' + esc(plugin ? plugin.name : upstream.plugin_id) + ' · 基础地址：<code>' + esc(upstream.base_url || '未配置') + '</code></div>' +
            '<div class="status">API Key：<code>' + esc(upstream.credential_id || '未配置') + '</code> <span class="pill ' + (upstream.credential_configured ? 'ok' : 'danger') + '">' + (upstream.credential_configured ? '已配置' : '缺少') + '</span></div>' +
            '<div class="status">模型 ' + esc(upstream.models_active + '/' + upstream.models_total) + '</div>' +
            '<div>' + models + '</div>' +
          '</div>';
        }).join('') : '<div class="empty">暂无上游配置。</div>';
      }

      function renderUsers() {
        document.getElementById('users-list').innerHTML = state.users.length ? state.users.map(function (user) {
          return '<article class="entity-card">' +
            '<header><div class="entity-title"><strong>' + esc(user.email) + '</strong><div class="status">' + esc(user.name || user.id) + '</div></div><span class="pill ' + statusClass(user.status) + '">' + esc(statusText(user.status)) + '</span></header>' +
            '<div class="entity-meta">' +
              '<div class="entity-row"><span>角色</span><strong>' + esc(roleText(user.role)) + '</strong></div>' +
              '<div class="entity-row"><span>组织</span><code>' + esc(user.organization_id) + '</code></div>' +
            '</div>' +
            '<div class="actions entity-actions"><button type="button" class="secondary compact" data-user-toggle="' + esc(user.id) + '">' + (user.status === 'active' ? '禁用' : '启用') + '</button>' + (user.status === 'active' ? '<button type="button" class="compact" data-user-impersonate="' + esc(user.id) + '" style="background:var(--accent);color:#052e1d;margin-left:4px;">登录为</button>' : '') + '</div>' +
          '</article>';
        }).join('') : '<div class="empty">暂无用户。</div>';
        document.getElementById('keys-list').innerHTML = state.apiKeys.length ? state.apiKeys.map(function (key) {
          return '<article class="entity-card">' +
            '<header><div class="entity-title"><strong>' + esc(key.name) + '</strong><div class="status"><code>' + esc(key.key_prefix) + '</code></div></div><span class="pill ' + statusClass(key.status) + '">' + esc(statusText(key.status)) + '</span></header>' +
            '<div class="entity-meta">' +
              '<div class="entity-row"><span>用户</span><code>' + esc(key.user_id) + '</code></div>' +
              '<div class="entity-row"><span>模型权限</span><div>' + esc((key.allowed_models || []).join(', ') || '全部') + '</div></div>' +
            '</div>' +
            '<div class="actions entity-actions"><button type="button" class="secondary compact" data-key-view="' + esc(key.id) + '">查看密钥</button><button type="button" class="secondary compact" data-key-toggle="' + esc(key.id) + '">' + (key.status === 'active' ? '禁用' : '启用') + '</button></div>' +
          '</article>';
        }).join('') : '<div class="empty">暂无接口密钥。</div>';
      }

      function renderUsage() {
        var usage = state.usage || { total_requests: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, media_count: 0, by_model: [], recent: [] };
        document.getElementById('usage-stats').innerHTML = stat('请求数', usage.total_requests) + stat('Total Token', usage.total_tokens) + stat('Input Token', usage.prompt_tokens) + stat('Output Token', usage.completion_tokens) + stat('媒体单位', usage.media_count) + stat('成本', usage.cost || 0);
        document.getElementById('usage-models').innerHTML = usage.by_model.length ? usage.by_model.map(function (item) { return '<tr><td><code>' + esc(item.model) + '</code></td><td>' + esc(item.requests) + '</td><td>' + esc(item.total_tokens) + '</td><td>' + esc(item.prompt_tokens) + '</td><td>' + esc(item.completion_tokens) + '</td><td>' + esc(item.media_count) + '</td></tr>'; }).join('') : '<tr><td colspan="6" class="empty">暂无用量。</td></tr>';
        document.getElementById('usage-recent').innerHTML = usage.recent.length ? usage.recent.slice(0, 12).map(function (item) { return '<div><span class="pill">' + esc(item.endpoint) + '</span><strong>' + esc(item.model) + '</strong><div class="status">' + esc(item.total_tokens) + ' Token · ' + esc(item.created_at) + '</div></div>'; }).join('') : '<div class="empty">暂无用量记录。</div>';
      }

      function renderTasks(tasks) {
        document.getElementById('tasks-table').innerHTML = tasks.length ? tasks.map(function (task) {
          var actions = '<button class="secondary compact" data-task-view="' + esc(task.id) + '">详情</button>';
          if (task.cancelable) actions += '<button class="danger compact" data-task-cancel="' + esc(task.id) + '">取消</button>';
          return '<tr><td><code>' + esc(task.id) + '</code></td><td>' + esc(taskTypeText(task.type)) + '</td><td>' + esc(task.model) + '</td><td><span class="pill ' + statusClass(task.status) + '">' + esc(statusText(task.status)) + '</span></td><td>' + esc(task.created_at) + '</td><td><div class="actions">' + actions + '</div></td></tr>';
        }).join('') : '<tr><td colspan="6" class="empty">暂无任务。</td></tr>';
      }

      function renderConfig() {
        var config = state.config || {};
        document.getElementById('current-config').textContent = config.config_json || '';
        document.getElementById('config-json').value = document.getElementById('config-json').value || config.config_json || '';
        document.getElementById('example-request').textContent = renderExample(config.example_chat_request);
      }

      async function saveModelFromForm() {
        var upstream_id = document.getElementById('model-upstream-select').value;
        if (!upstream_id) { setStatus('请先选择所属上游', 'error'); return; }
        var model = { upstream_id: upstream_id, alias: value('model-alias'), provider_model: value('route-provider-model'), modality: value('model-modality'), supports_stream: value('model-stream') === 'true', status: value('model-status'), priority: Number(value('route-priority') || 1), weight: 100 };
        await saveModel(model);
        closeModal('model-modal');
      }
      async function saveModelFromJson() { await saveModel(JSON.parse(document.getElementById('model-json').value)); }
      async function saveModel(model) { await api('/admin/api/models', { method: 'POST', body: JSON.stringify({ model: model }) }); await loadAll(); setStatus('模型已保存：' + model.alias, 'ok'); }
      async function resetModels() { if (!confirm('确定重置模型配置？')) return; await api('/admin/api/models/reset', { method: 'POST' }); document.getElementById('model-json').value = ''; await loadAll(); setStatus('模型配置已重置。', 'ok'); }

      async function saveUpstreamFromForm() {
        var existingId = value('upstream-admin-id');
        var upstream = { upstream_id: existingId || undefined, id: existingId || undefined, name: value('upstream-admin-name'), plugin_id: value('upstream-admin-plugin'), base_url: value('upstream-admin-base-url'), credential_id: value('upstream-admin-credential'), status: value('upstream-admin-status') };
        await api('/admin/api/upstreams', { method: 'POST', body: JSON.stringify({ upstream: upstream }) });
        await loadAll();
        setStatus('上游已保存：' + upstream.name, 'ok');
        closeModal('upstream-modal');
      }

      function resetUpstreamForm() {
        document.getElementById('upstream-admin-id').value = '';
        document.getElementById('upstream-admin-name').value = 'OpenAI Compatible Default';
        var pluginSelect = document.getElementById('upstream-admin-plugin');
        if (pluginSelect.options.length > 0) pluginSelect.selectedIndex = 0;
        document.getElementById('upstream-admin-base-url').value = '';
        document.getElementById('upstream-admin-credential').value = '';
        document.getElementById('upstream-admin-status').value = 'active';
      }

      function resetModelForm() {
        document.getElementById('model-alias').value = '';
        document.getElementById('route-provider-model').value = '';
        document.getElementById('model-modality').value = 'text';
        document.getElementById('model-status').value = 'active';
        document.getElementById('model-stream').value = 'true';
        document.getElementById('route-priority').value = '1';
        populateUpstreamSelect();
        document.getElementById('model-upstream-select').value = '';
      }

      function resetUserForm() {
        document.getElementById('user-email').value = '';
        document.getElementById('user-name').value = '';
        document.getElementById('user-role').value = 'member';
      }

      async function createUser() {
        var body = { email: value('user-email'), name: value('user-name'), role: value('user-role') };
        await api('/admin/api/users', { method: 'POST', body: JSON.stringify(body) });
        await loadAll(); setStatus('用户已创建：' + body.email, 'ok'); closeModal('user-modal'); resetUserForm();
      }
      async function revealApiKey() {
        var keyId = document.getElementById('reveal-key-confirm').getAttribute('data-reveal-key-id');
        var password = document.getElementById('reveal-password').value;
        if (!password) { document.getElementById('reveal-error').style.display = 'block'; document.getElementById('reveal-error').textContent = '请输入管理员密码。'; return; }
        document.getElementById('reveal-error').style.display = 'none';
        try {
          var data = await api('/admin/api/api-keys/' + encodeURIComponent(keyId) + '/reveal', { method: 'POST', body: JSON.stringify({ password: password }) });
          document.getElementById('reveal-result').style.display = 'block';
          document.getElementById('reveal-result').innerHTML = '<strong>密钥明文：</strong><p><code style="word-break:break-all;">' + esc(data.token) + '</code></p><button class="compact" id="copy-revealed-key" type="button">复制</button><p class="muted">请妥善保管，关闭窗口后需再次验证。</p>';
          document.getElementById('copy-revealed-key').addEventListener('click', function () { navigator.clipboard.writeText(data.token); setStatus('密钥已复制到剪贴板', 'ok'); });
          document.getElementById('reveal-password').value = '';
        } catch (error) {
          document.getElementById('reveal-error').style.display = 'block';
          document.getElementById('reveal-error').textContent = error.message || '验证失败';
        }
      }
      async function loadTasks() {
        var params = new URLSearchParams(); params.set('limit', value('task-limit')); if (value('task-status')) params.set('status', value('task-status')); if (value('task-query')) params.set('q', value('task-query'));
        var data = await api('/admin/api/tasks?' + params.toString()); state.tasks = data.data || []; renderTasks(state.tasks); setStatus('任务已加载。', 'ok');
      }
      async function validateConfig() { var data = await api('/admin/api/config/validate', { method: 'POST', body: JSON.stringify({ config_json: value('config-json') }) }); document.getElementById('config-output').textContent = JSON.stringify(data, null, 2); }
      function fillCurrentConfig() { document.getElementById('config-json').value = state.config ? state.config.config_json : ''; }

      async function handleModelAction(event) {
        var edit = event.target.closest('[data-model-edit]'); var del = event.target.closest('[data-model-delete]');
        if (edit) { fillModelEditor(edit.getAttribute('data-model-edit')); openModal('model-modal', 'model-modal-title', '编辑模型'); }
        if (del && confirm('确定删除模型 ' + del.getAttribute('data-model-delete') + '？')) { await api('/admin/api/models/' + encodeURIComponent(del.getAttribute('data-model-delete')), { method: 'DELETE' }); await loadAll(); }
      }

      async function handleUpstreamAction(event) {
        var view = event.target.closest('[data-upstream-view]'); var edit = event.target.closest('[data-upstream-edit]'); var del = event.target.closest('[data-upstream-delete]');
        if (view) { viewUpstream(view.getAttribute('data-upstream-view')); }
        if (edit) { fillUpstreamEditor(edit.getAttribute('data-upstream-edit')); openModal('upstream-modal', 'upstream-modal-title', '编辑上游'); }
        if (del && !del.disabled && confirm('确定删除上游 ' + del.getAttribute('data-upstream-delete') + '？')) { await api('/admin/api/upstreams/' + encodeURIComponent(del.getAttribute('data-upstream-delete')), { method: 'DELETE' }); await loadAll(); }
      }
      async function handleUserAction(event) { var toggleBtn = event.target.closest('[data-user-toggle]'); var impersonateBtn = event.target.closest('[data-user-impersonate]'); if (impersonateBtn) { var impersonateId = impersonateBtn.getAttribute('data-user-impersonate'); var impersonateUser = state.users.find(function (item) { return item.id === impersonateId; }); if (!impersonateUser) return; if (!confirm('将以 ' + impersonateUser.email + ' 的身份登录用户中心，确认继续？')) return; var impersonateWindow = window.open('about:blank', '_blank'); setStatus('正在模拟登录...', 'ok'); try { var impersonateData = await api('/admin/api/users/' + encodeURIComponent(impersonateId) + '/impersonate', { method: 'POST' }); var accountUrl = impersonateData.redirect || '/account'; if (impersonateWindow) impersonateWindow.location.assign(accountUrl); else window.open(accountUrl, '_blank'); setStatus('已在新窗口打开用户中心：' + impersonateUser.email, 'ok'); } catch (error) { if (impersonateWindow) impersonateWindow.close(); setStatus(error.message || '模拟登录失败', 'error'); } return; } if (!toggleBtn) return; var user = state.users.find(function (item) { return item.id === toggleBtn.getAttribute('data-user-toggle'); }); if (!user) return; await api('/admin/api/users/' + encodeURIComponent(user.id), { method: 'PATCH', body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) }); await loadAll(); }
      async function handleKeyAction(event) { var viewBtn = event.target.closest('[data-key-view]'); var toggleBtn = event.target.closest('[data-key-toggle]'); if (viewBtn) { var keyId = viewBtn.getAttribute('data-key-view'); var key = state.apiKeys.find(function (item) { return item.id === keyId; }); if (!key) return; document.getElementById('key-reveal-title').textContent = '查看密钥：' + esc(key.name); document.getElementById('reveal-password').value = ''; document.getElementById('reveal-error').style.display = 'none'; document.getElementById('reveal-result').style.display = 'none'; document.getElementById('reveal-key-confirm').setAttribute('data-reveal-key-id', keyId); openModal('key-reveal-modal', 'key-reveal-title', '查看密钥：' + esc(key.name)); return; } if (!toggleBtn) return; var key = state.apiKeys.find(function (item) { return item.id === toggleBtn.getAttribute('data-key-toggle'); }); if (!key) return; await api('/admin/api/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: JSON.stringify({ status: key.status === 'active' ? 'disabled' : 'active' }) }); await loadAll(); }
      async function handleTaskAction(event) { var view = event.target.closest('[data-task-view]'); var cancel = event.target.closest('[data-task-cancel]'); if (view) { var detail = await api('/admin/api/tasks/' + encodeURIComponent(view.getAttribute('data-task-view'))); document.getElementById('task-detail').textContent = JSON.stringify(detail.task, null, 2); } if (cancel && confirm('确定取消任务？')) { await api('/admin/api/tasks/' + encodeURIComponent(cancel.getAttribute('data-task-cancel')) + '/cancel', { method: 'POST' }); await loadTasks(); } }

      function fillModelEditor(alias) { var model = state.models.find(function (item) { return item.alias === alias; }); if (!model) return; var route = model.routes && model.routes[0] ? model.routes[0] : {}; document.getElementById('model-json').value = JSON.stringify(toModelInput(model), null, 2); document.getElementById('model-alias').value = model.alias; document.getElementById('model-modality').value = model.modality; document.getElementById('model-status').value = model.status; document.getElementById('model-stream').value = String(model.supports_stream !== false); var select = document.getElementById('model-upstream-select'); if (select.options.length > 1) { select.value = route.upstream_id || ''; } document.getElementById('route-provider-model').value = route.provider_model || ''; document.getElementById('route-priority').value = route.priority || 1; }
      function toModelInput(model) { var route = model.routes && model.routes[0] ? model.routes[0] : {}; return { upstream_id: route.upstream_id, alias: model.alias, provider_model: route.provider_model, modality: model.modality, supports_stream: model.supports_stream, status: model.status, priority: route.priority, weight: route.weight }; }
      function fillUpstreamEditor(id) { var upstreams = (state.overview && state.overview.upstreams) || []; var upstream = upstreams.find(function (item) { return item.id === id; }); if (!upstream) return; document.getElementById('upstream-admin-id').value = upstream.id || ''; document.getElementById('upstream-admin-name').value = upstream.name || ''; document.getElementById('upstream-admin-plugin').value = upstream.plugin_id || ''; document.getElementById('upstream-admin-base-url').value = upstream.base_url || ''; document.getElementById('upstream-admin-credential').value = upstream.credential_id || ''; document.getElementById('upstream-admin-status').value = upstream.status || 'active'; }
      function viewUpstream(id) { var upstream = findOverviewUpstream(id); if (!upstream) { setStatus('未找到上游：' + id, 'error'); return; } var raw = findConfigUpstream(id) || upstream; var name = upstream.name || upstream.id; document.getElementById('upstream-view-title').textContent = '查看上游：' + name; document.getElementById('upstream-view-content').innerHTML = renderUpstreamDetail(upstream, raw); document.getElementById('upstream-view-json').textContent = JSON.stringify(toUpstreamDetailJson(upstream, raw), null, 2); openModal('upstream-view-modal', 'upstream-view-title', '查看上游：' + name); }
      function renderUpstreamDetail(upstream, raw) { var providers = (state.overview && state.overview.providers) || []; var plugin = findProvider(providers, upstream.plugin_id); var models = (raw && raw.models) || upstream.models || []; var modelRows = models.length ? models.map(function (model) { return '<tr><td><code>' + esc(model.alias) + '</code></td><td><code>' + esc(model.provider_model) + '</code></td><td>' + esc(modalityText(model.modality)) + '</td><td><span class="pill ' + statusClass(model.status || 'active') + '">' + esc(statusText(model.status || 'active')) + '</span></td><td>' + (model.supports_stream !== false ? '支持' : '不支持') + '</td><td>' + esc(model.priority == null ? '未设置' : model.priority) + '</td><td>' + esc(model.weight == null ? '未设置' : model.weight) + '</td></tr>'; }).join('') : '<tr><td colspan="7" class="empty">暂无模型。</td></tr>'; return '<div class="entity-meta">' +
          '<div class="entity-row"><span>ID</span><code>' + esc(upstream.id) + '</code></div>' +
          '<div class="entity-row"><span>名称</span><strong>' + esc(upstream.name || upstream.id) + '</strong></div>' +
          '<div class="entity-row"><span>类型</span><strong>' + esc(plugin ? plugin.name : upstream.plugin_id) + '</strong></div>' +
          '<div class="entity-row"><span>插件 ID</span><code>' + esc(upstream.plugin_id) + '</code></div>' +
          '<div class="entity-row"><span>基础地址</span><code>' + esc(upstream.base_url || '未配置') + '</code></div>' +
          '<div class="entity-row"><span>API Key</span><div><code>' + esc(upstream.credential_id || '未配置') + '</code><br><span class="pill ' + (upstream.credential_configured ? 'ok' : 'danger') + '">' + (upstream.credential_configured ? '已配置' : '缺少') + '</span></div></div>' +
          '<div class="entity-row"><span>状态</span><span class="pill ' + statusClass(upstream.status) + '">' + esc(statusText(upstream.status)) + '</span></div>' +
          '<div class="entity-row"><span>模型</span><strong>' + esc(upstream.models_active + '/' + upstream.models_total) + '</strong></div>' +
          '<div class="entity-row"><span>活跃路由</span><strong>' + esc(upstream.routes_active == null ? 0 : upstream.routes_active) + '</strong></div>' +
        '</div>' +
        '<div><h3>模型明细</h3><div class="table-wrap"><table><thead><tr><th>别名</th><th>上游模型</th><th>模态</th><th>状态</th><th>流式</th><th>优先级</th><th>权重</th></tr></thead><tbody>' + modelRows + '</tbody></table></div></div>' +
        '<div class="status">下方 JSON 为当前上游完整配置。</div>'; }
      function toUpstreamDetailJson(upstream, raw) { return Object.assign({}, raw || {}, { credential_configured: upstream.credential_configured, models_total: upstream.models_total, models_active: upstream.models_active, routes_active: upstream.routes_active == null ? 0 : upstream.routes_active }); }
      function findOverviewUpstream(id) { var upstreams = (state.overview && state.overview.upstreams) || []; return upstreams.find(function (item) { return item.id === id; }) || null; }
      function findConfigUpstream(id) { var upstreams = (state.config && state.config.config && state.config.config.upstreams) || []; return upstreams.find(function (item) { return item.id === id; }) || null; }
      function openModal(id, titleId, title) { var modal = document.getElementById(id); if (!modal) return; document.getElementById(titleId).textContent = title; modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.classList.add('modal-open'); var firstField = modal.querySelector('.modal-form input:not([type="hidden"]), .modal-form select, .modal-form textarea'); if (firstField) firstField.focus(); }
      function closeModal(id) { var modals = id ? [document.getElementById(id)] : Array.prototype.slice.call(document.querySelectorAll('.modal.open')); modals.forEach(function (modal) { if (!modal) return; modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }); if (!document.querySelector('.modal.open')) document.body.classList.remove('modal-open'); }
      function showSection(section) { section = titles[section] ? section : 'dashboard'; document.querySelectorAll('.section').forEach(function (el) { el.classList.toggle('active', el.id === section); }); document.querySelectorAll('.nav a').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-section') === section); }); document.getElementById('page-title').textContent = titles[section]; }
      function toggleTheme() { var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('teaven_admin_theme', next); document.getElementById('theme-toggle').textContent = next === 'dark' ? '切换浅色' : '切换深色'; }
      function stat(label, value) { return '<div class="stat"><strong>' + esc(value == null ? 0 : value) + '</strong><span>' + esc(label) + '</span></div>'; }
      function meta(label, value) { return '<div><span class="pill">' + esc(label) + '</span><strong>' + esc(value == null ? '' : value) + '</strong></div>'; }
      function renderExample(req) { if (!req) return '暂无示例'; var quote = String.fromCharCode(39); return 'curl -X ' + req.method + ' "' + location.origin + req.endpoint + '"\\n  -H "Authorization: Bearer <DEV_API_KEY>"\\n  -H "Content-Type: application/json"\\n  -d ' + quote + JSON.stringify(req.body, null, 2) + quote; }
      function value(id) { return document.getElementById(id).value.trim(); }
      function yesNo(value) { return value ? '已绑定' : '未绑定'; }
      function taskStoreText(value) { return value === 'kv' ? 'KV' : value === 'memory' ? '内存' : value; }
      function modalityText(value) { if (value === 'text') return '文本'; if (value === 'image') return '图片'; if (value === 'video') return '视频'; if (value === 'file') return '文件'; if (value === 'vision') return '视觉'; if (value === 'audio') return '音频'; return value; }
      function roleText(value) { if (value === 'owner') return '所有者'; if (value === 'admin') return '管理员'; if (value === 'member') return '成员'; return value; }
      function taskTypeText(value) { if (value === 'chat.completions') return '聊天补全'; if (value === 'image.generations') return '图片生成'; if (value === 'video.generations') return '视频生成'; return value; }
      function statusText(status) { if (status === 'active') return '启用'; if (status === 'degraded') return '降级'; if (status === 'hidden') return '隐藏'; if (status === 'disabled') return '停用'; if (status === 'queued') return '排队中'; if (status === 'running') return '运行中'; if (status === 'succeeded') return '成功'; if (status === 'failed') return '失败'; if (status === 'canceled') return '已取消'; if (status === 'expired') return '已过期'; if (status === 'ok') return '正常'; if (status === 'warning') return '警告'; if (status === 'error') return '异常'; return status; }
      function statusClass(status) { if (status === 'active' || status === 'succeeded' || status === 'running' || status === 'ok') return 'ok'; if (status === 'queued' || status === 'hidden' || status === 'degraded' || status === 'warning') return 'warn'; if (status === 'disabled' || status === 'failed' || status === 'canceled' || status === 'expired' || status === 'error') return 'danger'; return ''; }
      function providerClass(status) { return statusClass(status); }
      function providerText(status) { return status === 'ok' ? '可用' : status === 'warning' ? '未使用' : status === 'error' ? '异常' : status; }
      function findProvider(providers, pluginId) { return providers.find(function (p) { return p.id === pluginId; }) || null; }
      function featureClass(status) { return status === 'ready' ? 'ok' : status === 'blocked' ? 'danger' : 'warn'; }
      function featureText(status) { return status === 'ready' ? '就绪' : status === 'partial' ? '部分可用' : status === 'planned' ? '待实现' : status === 'blocked' ? '阻塞' : status; }
      function setStatus(message, kind) { statusEl.textContent = message; statusEl.className = 'subtitle' + (kind ? ' ' + kind : ''); }
      function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    })();
  </script>
</body>
</html>`;

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
        <p class="subtitle">管理当前边缘服务部署：查看模型、供应商接入、存储绑定和异步任务。</p>
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
        <p class="subtitle">这里展示当前实际加载的网关配置，不包含任何密钥明文。</p>
        <pre id="current-config" class="json-view">正在加载配置...</pre>
      </div>

      <div class="card span-6">
        <h2>接口调用示例</h2>
        <p class="subtitle">用于快速验证当前模型别名和用户接口鉴权。</p>
        <pre id="example-request" class="json-view">正在生成示例...</pre>
      </div>

      <div class="card span-12">
        <h2>模型配置 JSON 校验器</h2>
        <p class="subtitle">在部署为 MODEL_CONFIG_JSON 之前，先粘贴网关配置 JSON 对象进行校验。</p>
        <textarea id="config-json" spellcheck="false" placeholder='{"upstreams":[{"id":"openai-compatible-default","name":"OpenAI Compatible Default","plugin_id":"openai-compatible","base_url":"https://api.openai.com/v1","credential_id":"env:OPENAI_COMPATIBLE_API_KEY","status":"active","models":[{"alias":"gpt-4o-mini","provider_model":"gpt-4o-mini","modality":"text","supports_stream":true,"priority":1,"weight":100,"status":"active"}]}]}'></textarea>
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
          setStatus('供应商检查完成：' + data.provider.name + ' / ' + providerStatusText(data.provider.status), data.provider.status === 'ok' ? 'ok' : 'error');
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
          renderMeta('用户接口密钥', data.gateway.dev_api_key_configured ? '已配置' : '未配置') +
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
          return '<span class="pill">' + escapeHtml((route.upstream_id || route.plugin_id) + ' / ' + route.provider_model) + '</span>' +
            (route.selected ? '<span class="pill ok">当前路由</span>' : '') +
            '<span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? 'Key 已配置' : '缺少 Key') + '</span>' +
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
          return '<span class="pill">' + escapeHtml(name + '：' + executionModeText(capability.execution_mode)) + '</span>';
        }).join('');
        var routes = provider.routes && provider.routes.length
          ? provider.routes.map(function (route) {
              return '<div class="status"><code>' + escapeHtml(route.model_alias) + '</code> @ ' + escapeHtml(route.upstream_id || '') + ' -> ' + escapeHtml(route.provider_model) + ' <span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? 'Key 已配置' : '缺少 Key') + '</span></div>';
            }).join('')
          : '<div class="status">当前没有模型路由使用该供应商。</div>';

        return '<div class="panel">' +
          '<h3>' + escapeHtml(provider.name) + '</h3>' +
          '<div class="pill ' + providerStatusClass(provider.status) + '">' + escapeHtml(providerStatusText(provider.status)) + '</div>' +
          '<div class="pill">' + escapeHtml(provider.id) + '</div>' +
          '<div class="pill">v' + escapeHtml(provider.version) + '</div>' +
          '<div class="pill">路由 ' + escapeHtml(provider.routes_configured + '/' + provider.routes_active) + '</div>' +
          '<div style="margin-top: 8px;">' + caps + '</div>' +
          routes +
          '<div class="actions" style="margin-top: 10px;"><button class="secondary compact" type="button" data-provider-health="' + escapeHtml(provider.id) + '">检查供应商</button></div>' +
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
        return '数据库 ' + yesNo(gateway.db_bound) + ', KV ' + yesNo(gateway.kv_bound) + ', 队列 ' + yesNo(gateway.queue_bound) + ', R2 ' + yesNo(gateway.r2_bound);
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
        if (value === 'image') {
          return '图片';
        }
        if (value === 'video') {
          return '视频';
        }
        if (value === 'file') {
          return '文件';
        }
        return value;
      }

      function executionModeText(value) {
        if (value === 'sync') {
          return '同步';
        }
        if (value === 'async') {
          return '异步';
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
        if (status === 'degraded') {
          return '降级';
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
        if (status === 'queued' || status === 'hidden' || status === 'degraded') {
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
        ].join('\\n');
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
