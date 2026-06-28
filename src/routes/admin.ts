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
import { listModelGroups, listModels, listProviderRoutes, loadGatewayConfig, resetGatewayConfig, saveGatewayConfig, validateGatewayConfig } from "../config";
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
  loadSiteSettings,
  revealAdminApiKeyToken,
  saveAdminApiKey,
  saveAdminUser,
  saveSiteSettings,
  summarizeUsage
} from "../admin/store";
import { createProviderRegistry, resolveProviderCredential } from "../providers/registry";
import type { ProviderPluginManifest } from "../providers/types";
import { appendTaskEvent, lastTaskEvent, taskDiagnostics } from "../tasks/events";
import { publicTaskOutput } from "../tasks/output";
import { getTask, listTasks, saveTask } from "../tasks/store";
import type {
  AsyncTaskRecord,
  AsyncTaskStatus,
  CredentialLimit,
  CredentialLimitWindow,
  CredentialStatus,
  Env,
  GatewayConfig,
  ModelConfig,
  ModelGroup,
  ModelGroupLevel,
  ModelGroupMember,
  Modality,
  ProviderRouteConfig,
  UpstreamConfig,
  UpstreamCredential,
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

    const adminTokenConfigured = Boolean(env.ADMIN_TOKEN);
    return htmlResponse(renderAdminLoginHtml("", adminTokenConfigured), {
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

  // ── 模型分组管理 ──
  if (request.method === "GET" && pathname === "/admin/api/model-groups") {
    return handleListAdminModelGroups(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/model-groups") {
    return handleUpsertAdminModelGroup(request, env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/model-groups/init-defaults") {
    return handleInitDefaultModelGroups(env, requestId);
  }

  const modelGroupMatch = pathname.match(/^\/admin\/api\/model-groups\/([^/]+)$/);
  if (modelGroupMatch) {
    const alias = decodeURIComponent(modelGroupMatch[1]);
    if (request.method === "PUT") {
      return handleUpsertAdminModelGroup(request, env, requestId, alias);
    }
    if (request.method === "DELETE") {
      return handleDeleteAdminModelGroup(alias, env, requestId);
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
    return handleGetAdminTask(decodeURIComponent(taskMatch[1]), env, requestId, request.url);
  }

  const providerHealthMatch = pathname.match(/^\/admin\/api\/providers\/([^/]+)\/health$/);
  if (request.method === "GET" && providerHealthMatch) {
    return handleProviderHealth(decodeURIComponent(providerHealthMatch[1]), env, requestId);
  }

  if (request.method === "GET" && pathname === "/admin/api/settings") {
    return handleGetSettings(env, requestId);
  }

  if (request.method === "PUT" && pathname === "/admin/api/settings") {
    return handleUpdateSettings(request, env, requestId);
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
    console.error(`[admin] login failed:`, error);
    const adminTokenConfigured = Boolean(env.ADMIN_TOKEN);
    return renderLoginError(
      error instanceof Error ? error.message : "登录失败。",
      requestId,
      500,
      adminTokenConfigured
    );
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

function renderLoginError(message: string, requestId: string, status: number, adminTokenConfigured = true): Response {
  return htmlResponse(renderAdminLoginHtml(message, adminTokenConfigured), {
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
      config_source: env.DB ? "D1" : env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
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

  const config = await loadGatewayConfig(env);
  if (expectedAlias) {
    const existingModel = listModels(config).find((model) => model.alias === expectedAlias);
    if (!existingModel) {
      throw notFound("模型不存在");
    }
    if (input.model.alias !== expectedAlias && listModels(config).some((model) => model.alias === input.model.alias)) {
      throw conflict("模型别名已存在");
    }
  }

  const nextUpstreams = upsertUpstreamModel(config, input, expectedAlias);
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
      config_source: env.DB ? "D1" : env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
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

async function handleListAdminModelGroups(env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  const models = listModels(config);
  return jsonResponse(
    {
      object: "list",
      data: listModelGroups(config).map((group) => publicModelGroup(group, models))
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpsertAdminModelGroup(
  request: Request,
  env: Env,
  requestId: string,
  expectedAlias?: string
): Promise<Response> {
  const body = await readJsonObject(request);
  const input = normalizeModelGroupInput(body.group ?? body);

  const config = await loadGatewayConfig(env);
  const groups = Array.isArray(config.model_groups) ? [...config.model_groups] : [];

  if (expectedAlias) {
    const existingIndex = groups.findIndex((group) => group.alias === expectedAlias);
    if (existingIndex === -1) {
      throw notFound("模型分组不存在");
    }
    // 修改 alias 时校验新 alias 不与其他组冲突
    if (input.alias !== expectedAlias && groups.some((group) => group.alias === input.alias)) {
      throw conflict("组别名已存在");
    }
    groups.splice(existingIndex, 1);
  } else if (groups.some((group) => group.alias === input.alias)) {
    throw conflict("组别名已存在");
  }

  groups.push(input);
  groups.sort((left, right) => left.alias.localeCompare(right.alias));

  const nextConfig: GatewayConfig = { ...config, model_groups: groups };
  await saveGatewayConfig(env, nextConfig); // 内部会调用 validateGatewayConfig 校验组成员引用

  const models = listModels(nextConfig);
  const saved = models; // 仅用于 publicModelGroup 查找成员详情
  return jsonResponse(
    {
      group: publicModelGroup(input, saved),
      config_source: env.DB ? "D1" : env.AI_GATEWAY_KV ? "AI_GATEWAY_KV" : "memory"
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleDeleteAdminModelGroup(alias: string, env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  const groups = Array.isArray(config.model_groups) ? config.model_groups : [];
  const nextGroups = groups.filter((group) => group.alias !== alias);
  if (nextGroups.length === groups.length) {
    throw notFound("模型分组不存在");
  }

  const nextConfig: GatewayConfig = { ...config, model_groups: nextGroups };
  await saveGatewayConfig(env, nextConfig);

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

/**
 * 一键初始化默认三组（tier:advanced / tier:standard / tier:basic）。
 * - 已存在的默认组跳过
 * - 没有可用 text 模型时报错（提示先添加模型）
 * - 默认把所有 text 模型作为成员填入各组（weight=1），fallback 取第一个成员
 *   用户后续可自行调整权重和成员
 */
async function handleInitDefaultModelGroups(env: Env, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  const groups = Array.isArray(config.model_groups) ? [...config.model_groups] : [];
  const reservedAliases: ModelGroupLevel[] = ["advanced", "standard", "basic"];
  const textModels = listModels(config).filter((model) => model.modality === "text");
  if (textModels.length === 0) {
    throw invalidRequest("请先添加至少一个 text 模型后再初始化默认分组", "models");
  }

  const defaultMembers: ModelGroupMember[] = textModels.map((model) => ({ alias: model.alias, weight: 1 }));
  const fallbackAlias = defaultMembers[0].alias;
  const created: string[] = [];
  const skipped: string[] = [];

  for (const level of reservedAliases) {
    const alias = `tier:${level}`;
    if (groups.some((group) => group.alias === alias)) {
      skipped.push(alias);
      continue;
    }
    groups.push({
      alias,
      name: alias,
      level,
      modality: "text",
      description: level === "advanced" ? "高级模型组" : level === "standard" ? "标准模型组" : "基础模型组",
      status: "active",
      fallback_member_alias: fallbackAlias,
      members: defaultMembers
    });
    created.push(alias);
  }

  groups.sort((left, right) => left.alias.localeCompare(right.alias));
  const nextConfig: GatewayConfig = { ...config, model_groups: groups };
  await saveGatewayConfig(env, nextConfig);

  const models = listModels(nextConfig);
  return jsonResponse(
    {
      created,
      skipped,
      groups: listModelGroups(nextConfig).map((group) => publicModelGroup(group, models))
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

async function handleGetAdminTask(taskId: string, env: Env, requestId: string, requestUrl?: string): Promise<Response> {
  const task = await getTask(env, taskId);
  if (!task) {
    throw notFound("任务不存在");
  }

  return jsonResponse(
    {
      task: {
        ...task,
        output: await publicTaskOutput(task.output, env, requestUrl)
      }
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
  const previousStatus = task.status;
  task.status = "canceled";
  task.updated_at = now;
  task.completed_at = now;
  appendTaskEvent(task, {
    stage: "task.canceled",
    previous_status: previousStatus,
    status: task.status,
    request_id: requestId,
    message: "Task canceled by admin"
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

async function handleGetSettings(env: Env, requestId: string): Promise<Response> {
  const settings = await loadSiteSettings(env);
  return jsonResponse(
    {
      settings: {
        files_public_base_url: settings.files_public_base_url || null,
        env_files_public_base_url: env.FILES_PUBLIC_BASE_URL || null
      }
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}

async function handleUpdateSettings(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const settings = await loadSiteSettings(env);

  if (body.files_public_base_url !== undefined) {
    if (body.files_public_base_url === null || body.files_public_base_url === "") {
      settings.files_public_base_url = undefined;
    } else {
      const url = requireString(body.files_public_base_url, "files_public_base_url");
      try {
        new URL(url);
      } catch {
        throw invalidRequest("files_public_base_url 必须是有效的 URL", "files_public_base_url");
      }
      settings.files_public_base_url = url;
    }
  }

  await saveSiteSettings(env, settings);

  return jsonResponse(
    {
      settings: {
        files_public_base_url: settings.files_public_base_url || null,
        env_files_public_base_url: env.FILES_PUBLIC_BASE_URL || null
      }
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
    image_mode: model.image_mode || null,
    status: model.status || "active",
    price: model.price || null,
    price_unit: model.price_unit || null,
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
      image_mode: route.image_mode || null,
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

  // 序列化多凭证配置。每个凭证的 credential_id 标注是否已配置（实际值是否能在 env 解析到）
  const credentials = Array.isArray(upstream.credentials) && upstream.credentials.length > 0
    ? upstream.credentials.map((cred) => ({
      id: cred.id,
      label: cred.label || null,
      credential_id: cred.credential_id || null,
      credential_configured: isCredentialIdConfigured(env, cred.credential_id),
      weight: cred.weight ?? 1,
      status: cred.status || "active",
      limits: Array.isArray(cred.limits) ? cred.limits.map((limit) => ({
        window: limit.window,
        max_requests: limit.max_requests ?? null,
        max_tokens: limit.max_tokens ?? null
      })) : []
    }))
    : [];

  return {
    id: upstream.id,
    name: upstream.name || upstream.id,
    plugin_id: upstream.plugin_id,
    base_url: upstream.base_url || null,
    credential_id: upstream.credential_id || null,
    credential_configured: isCredentialIdConfigured(env, upstream.credential_id),
    // 多凭证池：当为空数组时回退到上方单 credential_id 字段
    credentials,
    credentials_count: credentials.length,
    status: upstream.status || "active",
    models_total: upstream.models.length,
    models_active: upstream.models.filter((model) => model.status !== "disabled").length,
    routes_active: activeRoutes.length,
    models: upstream.models.map((model) => ({
      alias: model.alias,
      provider_model: model.provider_model,
      modality: model.modality,
      supports_stream: model.supports_stream !== false,
      image_mode: model.image_mode || null,
      priority: model.priority ?? null,
      weight: model.weight ?? null,
      status: model.status || "active"
    }))
  };
}

/**
 * 序列化模型分组为对外 JSON。
 * `models` 用于补全成员的展示信息（modality/status/provider_model 等），便于前端一次性渲染。
 */
function publicModelGroup(group: ModelGroup, models: ModelConfig[]): Record<string, unknown> {
  const modelMap = new Map(models.map((model) => [model.alias, model]));
  const reservedAliases = new Set(["tier:advanced", "tier:standard", "tier:basic"]);
  return {
    alias: group.alias,
    name: group.name || null,
    level: group.level,
    is_default: reservedAliases.has(group.alias),
    description: group.description || null,
    modality: group.modality,
    status: group.status || "active",
    fallback_member_alias: group.fallback_member_alias || null,
    members_count: group.members.length,
    members: group.members.map((member) => {
      const model = modelMap.get(member.alias);
      return {
        alias: member.alias,
        weight: member.weight ?? 1,
        modality: model?.modality || null,
        provider_model: model?.routes[0]?.provider_model || null,
        status: model?.status || null,
        available: Boolean(model)
      };
    })
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
    upstream_id: task.upstream_id || null,
    plugin_id: task.plugin_id || null,
    provider_task_id: task.provider_task_id || null,
    cancelable: isCancelableTask(task),
    store_output: task.store_output,
    callback_url: task.callback_url || null,
    diagnostics: taskDiagnostics(task),
    last_event: lastTaskEvent(task),
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
    image_mode: normalizeImageMode(input.image_mode, modality),
    priority: optionalNumber(input.priority, "priority"),
    weight: optionalNumber(input.weight, "weight"),
    status: normalizeModelStatus(input.status),
    price: typeof input.price === "string" ? input.price : undefined,
    price_unit: input.price_unit === "per_1m_tokens" || input.price_unit === "per_call" ? input.price_unit : undefined
  };

  return { upstream_id, model };
}

/** 校验并规范化模型分组输入。成员引用合法性在 saveGatewayConfig → validateModelGroups 中再校验。 */
function normalizeModelGroupInput(value: unknown): ModelGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("group 必须是对象", "group");
  }

  const input = value as Record<string, unknown>;
  const alias = requireString(input.alias, "alias");
  const levelRaw = requireString(input.level, "level");
  if (!["advanced", "standard", "basic", "custom"].includes(levelRaw)) {
    throw invalidRequest("level 必须是 advanced、standard、basic 或 custom", "level");
  }
  const modalityRaw = requireString(input.modality, "modality");
  if (!["text", "image", "video", "file"].includes(modalityRaw)) {
    throw invalidRequest("modality 必须是 text、image、video 或 file", "modality");
  }

  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw invalidRequest("members 必须是非空数组", "members");
  }

  const memberAliases = new Set<string>();
  const members: ModelGroupMember[] = input.members.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidRequest(`members[${index}] 必须是对象`, "members");
    }
    const memberInput = raw as Record<string, unknown>;
    const memberAlias = requireString(memberInput.alias, `members[${index}].alias`);
    if (memberAliases.has(memberAlias)) {
      throw invalidRequest(`members[${index}].alias 重复：${memberAlias}`, "members");
    }
    memberAliases.add(memberAlias);

    const weight = optionalNumber(memberInput.weight, `members[${index}].weight`);
    if (weight !== undefined && weight < 0) {
      throw invalidRequest(`members[${index}].weight 必须是非负数`, "members");
    }

    return { alias: memberAlias, weight };
  });

  const fallback = optionalBodyString(input.fallback_member_alias, "fallback_member_alias");
  if (fallback && !memberAliases.has(fallback)) {
    throw invalidRequest("fallback_member_alias 必须存在于 members 中", "fallback_member_alias");
  }

  const status: ModelGroup["status"] =
    input.status === undefined || input.status === null || input.status === ""
      ? "active"
      : input.status === "active" || input.status === "disabled"
        ? input.status
        : (() => {
            throw invalidRequest("status 必须是 active 或 disabled", "status");
          })();

  return {
    alias,
    name: optionalBodyString(input.name, "name"),
    level: levelRaw as ModelGroupLevel,
    description: optionalBodyString(input.description, "description"),
    modality: modalityRaw as Modality,
    status,
    fallback_member_alias: fallback,
    members
  };
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
    credentials: readUpstreamCredentials(upstream.credentials),
    config: optionalObject(upstream.config, "config"),
    status: normalizeUpstreamStatus(upstream.status)
  };
}

/**
 * 解析上游多凭证配置。
 * 输入可为 undefined（保持向后兼容），或凭证对象数组。
 * 自动补全 id、过滤空凭证、归一化 limits。
 */
function readUpstreamCredentials(raw: unknown): UpstreamCredential[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw invalidRequest("credentials 必须是数组", "credentials");
  }

  const result: UpstreamCredential[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidRequest(`credentials[${index}] 必须是对象`, "credentials");
    }
    const record = item as Record<string, unknown>;

    const credentialId = requireString(record.credential_id, `credentials[${index}].credential_id`);
    // id 缺失时自动按索引生成稳定 tracking id
    let credId = typeof record.id === "string" && record.id.length > 0 ? record.id : `key${index + 1}`;
    if (ids.has(credId)) {
      throw invalidRequest(`credentials[${index}].id 重复：${credId}`, "credentials");
    }
    ids.add(credId);

    const label = optionalBodyString(record.label, `credentials[${index}].label`);

    let weight: number | undefined;
    if (record.weight !== undefined && record.weight !== null && record.weight !== "") {
      weight = Number(record.weight);
      if (!Number.isFinite(weight) || weight < 0) {
        throw invalidRequest(`credentials[${index}].weight 必须是非负数`, "credentials");
      }
    }

    const status = normalizeCredentialStatus(record.status, `credentials[${index}].status`);
    const limits = readCredentialLimits(record.limits, `credentials[${index}].limits`);

    result.push({
      id: credId,
      label: label || undefined,
      credential_id: credentialId,
      weight,
      limits,
      status
    });
  }

  return result.length > 0 ? result : undefined;
}

/** 解析单个凭证的配额上限数组。 */
function readCredentialLimits(raw: unknown, path: string): CredentialLimit[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw invalidRequest(`${path} 必须是数组`, "limits");
  }

  const result: CredentialLimit[] = [];
  const windows = new Set<CredentialLimitWindow>();
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidRequest(`${path}[${index}] 必须是对象`, "limits");
    }
    const record = item as Record<string, unknown>;

    const window = requireString(record.window, `${path}[${index}].window`);
    if (!["hour", "day", "week", "month"].includes(window)) {
      throw invalidRequest(`${path}[${index}].window 必须是 hour/day/week/month`, "limits");
    }
    const windowType = window as CredentialLimitWindow;
    if (windows.has(windowType)) {
      throw invalidRequest(`${path}[${index}].window 重复：${window}`, "limits");
    }
    windows.add(windowType);

    let maxRequests: number | undefined;
    let maxTokens: number | undefined;
    if (record.max_requests !== undefined && record.max_requests !== null && record.max_requests !== "") {
      maxRequests = Number(record.max_requests);
      if (!Number.isFinite(maxRequests) || maxRequests < 0 || !Number.isInteger(maxRequests)) {
        throw invalidRequest(`${path}[${index}].max_requests 必须是非负整数`, "limits");
      }
    }
    if (record.max_tokens !== undefined && record.max_tokens !== null && record.max_tokens !== "") {
      maxTokens = Number(record.max_tokens);
      if (!Number.isFinite(maxTokens) || maxTokens < 0 || !Number.isInteger(maxTokens)) {
        throw invalidRequest(`${path}[${index}].max_tokens 必须是非负整数`, "limits");
      }
    }

    if (maxRequests === undefined && maxTokens === undefined) {
      throw invalidRequest(`${path}[${index}] 至少需要配置 max_requests 或 max_tokens`, "limits");
    }

    result.push({ window: windowType, max_requests: maxRequests, max_tokens: maxTokens });
  }

  return result.length > 0 ? result : undefined;
}

function normalizeCredentialStatus(value: unknown, path: string): CredentialStatus {
  if (value === undefined || value === null || value === "") {
    return "active";
  }
  if (value === "active" || value === "disabled") {
    return value;
  }
  throw invalidRequest(`${path} 必须是 active 或 disabled`, "status");
}

function upsertUpstreamModel(config: GatewayConfig, input: AdminModelMutation, replaceAlias?: string): UpstreamConfig[] {
  const upstreams = config.upstreams.map((upstream) => ({ ...upstream, models: [...upstream.models] }));
  const target = upstreams.find((upstream) => upstream.id === input.upstream_id);

  if (!target) {
    throw invalidRequest(`上游 ${input.upstream_id} 不存在，请先在上游管理中创建`, "upstream_id");
  }

  if (replaceAlias) {
    const aliasesToReplace = new Set([input.model.alias, replaceAlias]);
    for (const upstream of upstreams) {
      upstream.models = upstream.models.filter((model) => !aliasesToReplace.has(model.alias));
    }
  } else {
    target.models = target.models.filter((model) => model.alias !== input.model.alias);
  }
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

function normalizeImageMode(value: unknown, modality: string): UpstreamModelConfig["image_mode"] {
  if (modality !== "image") {
    return undefined;
  }
  if (value === undefined || value === null || value === "") {
    return "text-to-image";
  }
  if (value === "text-to-image" || value === "image-to-image" || value === "both") {
    return value;
  }
  throw invalidRequest("图片生成模式必须是 text-to-image、image-to-image 或 both", "image_mode");
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

function renderAdminLoginHtml(errorMessage = "", adminTokenConfigured = true): string {
  const errorHtml = errorMessage ? `<div class="alert">${escapeHtml(errorMessage)}</div>` : "";
  const noticeHtml = !adminTokenConfigured
    ? `<div class="notice"><strong>管理员密码尚未配置</strong><br>请通过 <code>wrangler secret put ADMIN_TOKEN</code> 或 Cloudflare Dashboard 设置环境变量 <code>ADMIN_TOKEN</code> 后再登录。</div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 Teaven AI 管理后台</title>
  <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/remixicon/4.6.0/remixicon.css">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f5fb;
      --panel: rgba(255, 255, 255, 0.86);
      --panel-strong: #ffffff;
      --panel-muted: #fbfaff;
      --line: rgba(96, 72, 140, 0.14);
      --line-strong: rgba(96, 72, 140, 0.22);
      --text: #171421;
      --muted: #6f687d;
      --muted-2: #928aa0;
      --accent: #6d28d9;
      --accent-strong: #5b21b6;
      --accent-soft: rgba(109, 40, 217, 0.1);
      --accent-glow: rgba(109, 40, 217, 0.22);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.12);
      --ok: #16a34a;
      --ok-soft: rgba(22, 163, 74, 0.12);
      --shadow: rgba(53, 38, 84, 0.11);
      --radius: 22px;
    }

    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0e0b14;
      --panel: rgba(24, 19, 34, 0.84);
      --panel-strong: #181322;
      --panel-muted: #120f1b;
      --line: rgba(194, 171, 255, 0.13);
      --line-strong: rgba(194, 171, 255, 0.22);
      --text: #f6f2ff;
      --muted: #c8c0d8;
      --muted-2: #8f86a3;
      --accent: #a78bfa;
      --accent-strong: #c4b5fd;
      --accent-soft: rgba(167, 139, 250, 0.13);
      --accent-glow: rgba(167, 139, 250, 0.18);
      --shadow: rgba(0, 0, 0, 0.32);
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at 8% 4%, var(--accent-glow), transparent 34rem),
        radial-gradient(circle at 92% 8%, rgba(109, 40, 217, 0.13), transparent 30rem),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      transition: background 220ms ease, color 220ms ease;
    }

    .login-shell {
      width: min(100%, 480px);
    }

    .top-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
      padding: 8px 10px;
      border-radius: 999px;
      color: var(--muted-2);
      font-size: 12px;
      font-weight: 800;
      transition: background 160ms ease, color 160ms ease;
    }

    .top-link i { font-size: 16px; }
    .top-link:hover { color: var(--accent-strong); background: var(--accent-soft); }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 28px 80px var(--shadow);
      padding: 28px;
      backdrop-filter: blur(20px);
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(109, 40, 217, 0.34), transparent);
      opacity: 0.85;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 22px;
    }

    .brand-mark {
      display: grid;
      width: 46px;
      height: 46px;
      place-items: center;
      flex: 0 0 auto;
      border-radius: 15px;
      color: #fff;
      background: var(--accent);
      box-shadow: 0 14px 32px var(--accent-glow);
    }

    .brand-mark i { font-size: 22px; }
    .brand-copy p { margin-top: 5px; color: var(--muted); font-size: 12px; line-height: 1.55; }

    h1,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(28px, 6vw, 42px);
      letter-spacing: -0.06em;
      line-height: 1.06;
    }

    p {
      color: var(--muted);
      margin-top: 14px;
      line-height: 1.7;
    }

    .form-grid {
      display: grid;
      gap: 13px;
      margin-top: 24px;
    }

    label {
      display: grid;
      gap: 8px;
      color: var(--text);
      font-size: 14px;
      font-weight: 900;
    }

    .required {
      color: var(--danger);
    }

    .help {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }

    input,
    button {
      width: 100%;
      font: inherit;
    }

    input {
      color: var(--text);
      background: var(--panel-strong);
      border: 1px solid var(--line);
      border-radius: 14px;
      outline: none;
      padding: 13px 14px;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-soft);
    }

    button {
      margin-top: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid var(--accent);
      border-radius: 14px;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
      font-weight: 900;
      padding: 13px 16px;
      transition: transform 150ms ease, box-shadow 150ms ease, background 150ms ease;
    }

    button i { font-size: 18px; }
    button:hover { background: var(--accent-strong); transform: translateY(-1px); box-shadow: 0 14px 32px var(--accent-glow); }

    .alert {
      margin-top: 16px;
      border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
      border-radius: 16px;
      background: var(--danger-soft);
      color: var(--danger);
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.6;
    }

    .notice {
      margin-top: 16px;
      border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
      border-radius: 16px;
      background: var(--accent-soft);
      color: var(--text);
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.7;
    }

    .notice strong {
      display: block;
      margin-bottom: 6px;
    }

    .notice code {
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--panel-muted);
      font-size: 12px;
    }

    .meta {
      margin-top: 18px;
      color: var(--muted-2);
      font-size: 12px;
      line-height: 1.6;
      text-align: center;
    }

    .theme-float {
      position: fixed;
      top: 18px;
      right: 18px;
      bottom: auto;
      width: auto;
      max-width: calc(100vw - 36px);
      margin-top: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 12px;
      height: 38px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--text);
      background: var(--panel);
      cursor: pointer;
      font-weight: 900;
      white-space: nowrap;
      transition: transform 160ms ease, border-color 160ms ease;
    }

    .theme-float:hover { transform: translateY(-1px); border-color: var(--line-strong); background: var(--panel); box-shadow: none; }
    .theme-float i { font-size: 18px; }

    @media (max-width: 480px) {
      body { padding: 16px; }
      .card { padding: 22px; }
      button { padding: 12px 14px; }
    }
  </style>
</head>
<body>
  <main class="login-shell">
    <a class="top-link" href="/"><i class="ri-arrow-left-line"></i>返回站点</a>
    <section class="card">
      <div class="brand">
        <div class="brand-mark"><i class="ri-instance-line"></i></div>
        <div class="brand-copy">
          <h1>管理员登录</h1>
          <p>验证管理员密码后进入 <span style="color:var(--accent-strong); font-weight:900;">Teaven AI Gateway</span> 后台。</p>
        </div>
      </div>
      <div class="form-grid">
        <label>管理员密码 <span class="required">*</span>
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入管理员密码" autofocus required>
        </label>
        <span class="help">登录成功后将自动进入管理后台。若密码错误，本页会提示重新输入。</span>
        ${errorHtml}
        ${noticeHtml}
      </div>
      <form action="/admin/login" method="post" style="margin-top: 18px;">
        <input type="hidden" name="password" id="hidden-password">
        <button type="submit"><i class="ri-login-box-line"></i>登录后台</button>
      </form>
      <div class="meta">如果你还没有管理员密码，请先在 Cloudflare 配置 <code>ADMIN_TOKEN</code>。</div>
    </section>
    <div class="meta">推荐使用现代浏览器访问后台，以获得更稳定的布局和交互体验。</div>
  </main>
  <button class="theme-float" id="theme-toggle" type="button"><i class="ri-contrast-2-line"></i><span id="theme-label">切换深色</span></button>
  <script>
    (function () {
      var stored = localStorage.getItem('teaven_admin_theme');
      var theme = stored || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(theme);

      var toggle = document.getElementById('theme-toggle');
      if (toggle) toggle.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        localStorage.setItem('teaven_admin_theme', next);
      });

      var form = document.querySelector('form[action="/admin/login"]');
      var visible = document.getElementById('password');
      var hidden = document.getElementById('hidden-password');
      if (form && visible && hidden) {
        form.addEventListener('submit', function () {
          hidden.value = visible.value;
        });
      }

      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
          if (localStorage.getItem('teaven_admin_theme')) return;
          applyTheme(event.matches ? 'dark' : 'light');
        });
      }

      function applyTheme(next) {
        document.documentElement.setAttribute('data-theme', next);
        var label = document.getElementById('theme-label');
        if (label) label.textContent = next === 'dark' ? '切换浅色' : '切换深色';
      }
    })();
  </script>
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
  <link rel="stylesheet" href="https://cdn.bootcdn.net/ajax/libs/remixicon/4.6.0/remixicon.css">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f5fb;
      --panel: rgba(255, 255, 255, 0.78);
      --panel-strong: #ffffff;
      --panel-muted: #fbfaff;
      --line: rgba(96, 72, 140, 0.14);
      --line-strong: rgba(96, 72, 140, 0.22);
      --text: #171421;
      --muted: #6f687d;
      --muted-2: #928aa0;
      --accent: #6d28d9;
      --accent-strong: #5b21b6;
      --accent-soft: rgba(109, 40, 217, 0.1);
      --accent-glow: rgba(109, 40, 217, 0.22);
      --ok: #16a34a;
      --ok-soft: rgba(22, 163, 74, 0.12);
      --warn: #d97706;
      --warn-soft: rgba(217, 119, 6, 0.13);
      --danger: #dc2626;
      --danger-soft: rgba(220, 38, 38, 0.12);
      --info: #2563eb;
      --info-soft: rgba(37, 99, 235, 0.12);
      --shadow: rgba(53, 38, 84, 0.11);
      --sidebar: 276px;
      --sidebar-collapsed: 88px;
      --radius: 18px;
    }

    html[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0e0b14;
      --panel: rgba(24, 19, 34, 0.78);
      --panel-strong: #181322;
      --panel-muted: #120f1b;
      --line: rgba(194, 171, 255, 0.13);
      --line-strong: rgba(194, 171, 255, 0.22);
      --text: #f6f2ff;
      --muted: #c8c0d8;
      --muted-2: #8f86a3;
      --accent: #a78bfa;
      --accent-strong: #c4b5fd;
      --accent-soft: rgba(167, 139, 250, 0.13);
      --accent-glow: rgba(167, 139, 250, 0.18);
      --shadow: rgba(0, 0, 0, 0.32);
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 8% 4%, var(--accent-glow), transparent 34rem),
        radial-gradient(circle at 92% 8%, rgba(109, 40, 217, 0.13), transparent 30rem),
        var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      transition: background 220ms ease, color 220ms ease;
    }
    body.modal-open, body.drawer-open { overflow: hidden; }
    button, input, select, textarea { font: inherit; }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 38px;
      border: 1px solid var(--accent);
      border-radius: 12px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-weight: 900;
      padding: 0 14px;
      transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease, border-color 160ms ease;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 12px 26px var(--accent-glow); }
    button.secondary { background: var(--panel); color: var(--text); border: 1px solid var(--line); }
    button.danger { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
    button.compact { min-height: 30px; padding: 0 10px; font-size: 12px; }
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
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    a { color: inherit; text-decoration: none; }

    .mobile-backdrop { position: fixed; inset: 0; z-index: 38; display: none; background: rgba(8, 6, 13, 0.45); backdrop-filter: blur(8px); }
    .mobile-backdrop.open { display: block; }
    .layout { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; transition: grid-template-columns 220ms ease; }
    .layout.collapsed { grid-template-columns: var(--sidebar-collapsed) minmax(0, 1fr); }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 18px 14px;
      background: color-mix(in srgb, var(--panel-strong) 82%, transparent);
      border-right: 1px solid var(--line);
      backdrop-filter: blur(22px);
      display: flex;
      flex-direction: column;
      gap: 18px;
      z-index: 40;
      transition: transform 220ms ease, background 220ms ease;
    }
    .brand { display: flex; align-items: center; gap: 12px; padding: 10px 10px 18px; border-bottom: 1px solid var(--line); }
    .brand-mark { display: grid; width: 42px; height: 42px; place-items: center; flex: 0 0 auto; border-radius: 14px; color: #fff; background: var(--accent); box-shadow: 0 14px 30px var(--accent-glow); }
    .brand-mark i { font-size: 20px; }
    .brand-copy { min-width: 0; }
    .eyebrow { color: var(--accent-strong); font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
    .brand h1 { margin: 4px 0 0; font-size: 22px; line-height: 1.08; letter-spacing: -0.04em; }
    .nav { display: grid; gap: 6px; }
    .nav a {
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 42px;
      padding: 0 12px;
      border-radius: 13px;
      font-size: 14px;
      font-weight: 900;
      transition: background 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .nav a i { font-size: 18px; }
    .nav a.active, .nav a:hover { color: var(--accent-strong); background: var(--accent-soft); }
    .nav a:hover { transform: translateX(2px); }
    .sidebar-footer { margin-top: auto; display: grid; gap: 10px; }
    .sidebar-note { padding: 12px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel-muted); color: var(--muted); font-size: 12px; line-height: 1.55; }
    .layout.collapsed .brand-copy, .layout.collapsed .nav span, .layout.collapsed .sidebar-footer { display: none; }
    .layout.collapsed .brand { justify-content: center; padding-inline: 0; }
    .layout.collapsed .nav a { justify-content: center; padding-inline: 0; }
    .content { min-width: 0; padding: 24px 26px 42px; }
    .topbar { position: sticky; top: 0; z-index: 35; display: flex; justify-content: space-between; gap: 18px; align-items: flex-end; margin: -24px -26px 22px; padding: 18px 26px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(20px); }
    .topbar h2 { margin: 0; font-size: clamp(26px, 3vw, 40px); letter-spacing: -0.06em; line-height: 1.08; }
    .subtitle { color: var(--muted); margin: 8px 0 0; font-size: 13px; line-height: 1.6; }
    .breadcrumb { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; color: var(--muted-2); font-size: 12px; font-weight: 800; }
    .breadcrumb strong { color: var(--accent-strong); }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .mobile-menu { display: none; }
    .icon-button { width: 38px; min-width: 38px; padding: 0; }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 18px;
      box-shadow: 0 18px 46px var(--shadow);
      backdrop-filter: blur(18px);
      position: relative;
      overflow: hidden;
    }
    .card::before { content: ""; position: absolute; inset: 0 0 auto; height: 1px; background: linear-gradient(90deg, transparent, rgba(109, 40, 217, 0.32), transparent); opacity: 0.8; }
    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-7 { grid-column: span 7; }
    .span-6 { grid-column: span 6; }
    .span-5 { grid-column: span 5; }
    .span-4 { grid-column: span 4; }
    .card h3 { margin: 0 0 12px; font-size: 19px; letter-spacing: -0.04em; }
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
      border-radius: 16px;
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
    .meta-row { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-size: 12px; }
    .meta-row .muted-label { display: inline; margin: 0; }
    .section { display: none; }
    .section.active { display: block; }
    .stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .stat { padding: 15px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; }
    .stat strong { display: block; font-size: 30px; letter-spacing: -0.06em; }
    .stat span, label { color: var(--muted); font-size: 12px; font-weight: 900; }
    .form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .form-grid label { display: grid; gap: 6px; }
    .stack { display: grid; gap: 10px; }
    .status { color: var(--muted); font-size: 13px; min-height: 20px; }
    .status.ok { color: var(--ok); }
    .status.error { color: var(--danger); }
    .pill { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); background: var(--panel-muted); font-size: 12px; font-weight: 900; margin: 2px 4px 2px 0; }
    .pill.ok { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
    .pill.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
    .pill.danger { color: var(--danger); background: var(--danger-soft); border-color: transparent; }
    .warning { padding: 11px 12px; border-radius: 14px; color: var(--warn); background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn) 26%, transparent); }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 12px 10px; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); background: color-mix(in srgb, var(--panel-muted) 78%, transparent); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    tbody tr:hover { background: var(--accent-soft); }
    code, pre { font-family: Consolas, "SFMono-Regular", monospace; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .json-view { max-height: 360px; overflow: auto; padding: 14px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; color: var(--text); font-size: 12px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; }
    .tasks-table { min-width: 760px; table-layout: fixed; }
    .task-detail-panel { padding: 14px; background: var(--panel-strong); border: 1px solid var(--line); border-radius: 16px; color: var(--text); font-size: 13px; }
    .task-detail-card { display: grid; gap: 12px; }
    .task-detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .task-detail-grid > div { min-width: 0; }
    .muted-label { display: block; color: var(--muted); font-size: 11px; font-weight: 900; margin-bottom: 4px; }
    .task-diagnostics { margin-top: 4px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
    .task-diagnostics > div { padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .task-events-scroll { margin-top: 4px; max-height: 260px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; }
    .task-events-table { margin: 0; min-width: 760px; table-layout: fixed; }
    .task-events-table td { word-break: break-word; }
    .task-json-block { margin-top: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); font-size: 12px; max-height: 180px; overflow: auto; }
    .image-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
    .image-preview-card { overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
    .image-preview-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: rgba(148, 163, 184, 0.08); }
    .image-preview-card footer { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 10px; font-size: 12px; color: var(--muted); }
    .time-cell { white-space: nowrap; }
    .break-all { word-break: break-all; }
    .actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .empty { color: var(--muted); padding: 12px 0; }
    .secret { border: 1px solid rgba(125, 211, 252, 0.38); border-radius: 18px; background: rgba(125, 211, 252, 0.1); padding: 14px; }
    .alert { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius: 16px; background: var(--danger-soft); color: var(--danger); padding: 12px 14px; font-size: 13px; }
    .settings-message { display: none; border-radius: 14px; padding: 11px 12px; font-size: 13px; font-weight: 800; }
    .settings-message.ok { display: block; color: var(--ok); background: var(--ok-soft); border: 1px solid color-mix(in srgb, var(--ok) 26%, transparent); }
    .settings-message.warn { display: block; color: var(--warn); background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn) 26%, transparent); }
    .settings-message.error { display: block; color: var(--danger); background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent); }
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
      .layout.collapsed { grid-template-columns: 1fr; }
      .sidebar { position: fixed; left: 0; width: 286px; transform: translateX(-105%); box-shadow: 0 20px 56px var(--shadow); }
      .sidebar.open { transform: translateX(0); }
      .layout.collapsed .brand-copy, .layout.collapsed .nav span, .layout.collapsed .sidebar-footer { display: block; }
      .layout.collapsed .nav a { justify-content: flex-start; padding-inline: 12px; }
      .content { padding: 18px 14px 34px; }
      .topbar { display: grid; margin: -18px -14px 20px; padding: 14px; }
      .toolbar { justify-content: flex-start; }
      .mobile-menu { display: inline-flex; }
      #sidebar-collapse { display: none; }
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
  <div class="mobile-backdrop" id="mobile-backdrop"></div>
  <div class="layout" id="admin-layout">
    <aside class="sidebar" id="sidebar" aria-label="管理后台导航">
      <div class="brand">
        <div class="brand-mark"><i class="ri-instance-line"></i></div>
        <div class="brand-copy">
          <div class="eyebrow">Teaven AI Gateway</div>
          <h1>管理后台</h1>
          <p class="subtitle">模型、用户、用量与运行状态。</p>
        </div>
      </div>
      <nav class="nav" id="nav">
        <a href="#dashboard" data-section="dashboard"><i class="ri-dashboard-3-line"></i><span>仪表盘</span></a>
        <a href="#upstreams" data-section="upstreams"><i class="ri-plug-line"></i><span>上游管理</span></a>
        <a href="#models" data-section="models"><i class="ri-route-line"></i><span>模型管理</span></a>
        <a href="#model-groups" data-section="model-groups"><i class="ri-stack-line"></i><span>模型分组</span></a>
        <a href="#users" data-section="users"><i class="ri-user-settings-line"></i><span>用户管理</span></a>
        <a href="#usage" data-section="usage"><i class="ri-bar-chart-box-line"></i><span>模型用量</span></a>
        <a href="#tasks" data-section="tasks"><i class="ri-time-line"></i><span>任务管理</span></a>
        <a href="#config" data-section="config"><i class="ri-settings-4-line"></i><span>配置工具</span></a>
        <a href="#settings" data-section="settings"><i class="ri-global-line"></i><span>站点设置</span></a>
        <a href="/account" target="_blank" rel="noreferrer"><i class="ri-account-circle-line"></i><span>用户中心</span></a>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-note">保留原后台能力：模型路由、上游配置、用户/API Key、用量、任务诊断和配置校验。</div>
        <button id="theme-toggle" class="secondary" type="button"><i class="ri-contrast-2-line"></i><span>切换主题</span></button>
        <form action="/admin/logout" method="post"><button class="secondary" type="submit" style="width: 100%;">退出登录</button></form>
      </div>
    </aside>
    <main class="content">
      <div class="topbar">
        <div>
          <div class="breadcrumb"><span>后台管理</span><i class="ri-arrow-right-s-line"></i><strong id="breadcrumb-section">仪表盘</strong><span>/admin</span></div>
          <h2 id="page-title">仪表盘</h2>
          <p id="status" class="subtitle">正在加载管理后台...</p>
        </div>
        <div class="toolbar">
          <button id="mobile-menu" class="secondary icon-button mobile-menu" type="button" aria-label="打开导航"><i class="ri-menu-2-line"></i></button>
          <button id="sidebar-collapse" class="secondary icon-button" type="button" aria-label="折叠导航"><i class="ri-side-bar-line"></i></button>
          <button id="refresh" class="secondary" type="button"><i class="ri-refresh-line"></i>刷新全部</button>
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
          <div class="card span-12">
            <h3>模型详情</h3>
            <div id="model-detail-content" class="stack"><div class="empty">点击模型列表中的“查看”显示模型信息。</div></div>
            <pre id="model-detail-json" class="json-view" style="margin-top: 14px; display: none;"></pre>
          </div>
        </div>
      </section>

      <section id="model-groups" class="section">
        <div class="grid">
          <div class="card span-12">
            <div class="card-head">
              <div>
                <h3>模型分组</h3>
                <p class="subtitle">把多个模型组合成一个别名，调用时按权重随机挑选；失败自动回退到指定成员。用户使用组别名调用，响应里也返回组别名，但用量记录会保留实际模型，便于通过 request_id 排查。</p>
              </div>
              <div class="actions" style="gap: 8px;">
                <button id="init-default-groups" class="secondary" type="button">初始化默认三组</button>
                <button id="open-group-modal" type="button">添加分组</button>
              </div>
            </div>
            <div id="model-groups-list" class="entity-grid"></div>
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
            <div class="table-wrap"><table class="tasks-table"><colgroup><col style="width:31%"><col style="width:12%"><col style="width:20%"><col style="width:10%"><col style="width:15%"><col style="width:12%"></colgroup><thead><tr><th>ID</th><th>类型</th><th>模型</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="tasks-table"></tbody></table></div>
          </div>

        </div>
      </section>

      <section id="config" class="section">
        <div class="grid">
          <div class="card span-6"><h3>当前网关配置</h3><pre id="current-config" class="json-view">正在加载...</pre></div>
          <div class="card span-6"><h3>接口调用示例</h3><pre id="example-request" class="json-view">正在加载...</pre></div>
          <div class="card span-12"><h3>模型配置 JSON 校验器</h3><textarea id="config-json" spellcheck="false"></textarea><div class="actions" style="margin-top: 12px;"><button id="fill-current-config" class="secondary" type="button">填入当前配置</button><button id="validate-config" type="button">校验</button></div><pre id="config-output" class="json-view" style="margin-top: 12px;">尚未执行校验。</pre></div>
        </div>
      </section>
      <section id="settings" class="section">
        <div class="grid">
          <div class="card span-12">
            <h3>文件域名设置</h3>
            <p style="color: var(--muted); margin: 8px 0 16px;">设置异步任务输出文件的公共访问域名。留空则使用环境变量 <code>FILES_PUBLIC_BASE_URL</code>，若都未设置则通过 Worker 代理访问。</p>
            <div style="display: grid; gap: 12px;">
              <label>环境变量 FILES_PUBLIC_BASE_URL（只读）<input id="settings-env-base-url" readonly placeholder="未设置" style="opacity: 0.6;"></label>
              <label>自定义文件域名<input id="settings-files-base-url" placeholder="https://pub-xxx.r2.dev 或 https://files.example.com"></label>
              <div class="actions" style="margin-top: 4px;"><button id="save-settings" type="button">保存设置</button><button id="clear-settings" class="secondary danger" type="button">清除自定义域名</button></div>
              <div id="settings-message" class="settings-message" role="status" aria-live="polite"></div>
              <pre id="settings-output" class="json-view" style="margin-top: 8px;">尚未保存。</pre>
            </div>
          </div>
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
          <label>API Key（默认凭证，凭证池为空时使用）<input id="upstream-admin-credential" value="env:OPENAI_COMPATIBLE_API_KEY" placeholder="env:MY_SECRET 或直接填写 sk-..."></label>
          <label>状态<select id="upstream-admin-status"><option value="active">启用</option><option value="degraded">降级</option><option value="disabled">停用</option></select></label>
        </div>
        <div class="credentials-pool-panel" style="margin-top: 18px; border-top: 1px dashed var(--border, #ddd); padding-top: 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <div>
              <strong>多凭证池（加权随机 + 配额）</strong>
              <p class="muted" style="margin: 4px 0 0; font-size: 12px;">配置后调用时按权重随机挑选可用 key，超额自动跳过；不配置则使用上方默认凭证。<code>credential_ref</code> 会写入用量与任务事件，便于排错。</p>
            </div>
            <button id="add-credential-btn" class="compact" type="button">+ 添加凭证</button>
          </div>
          <div id="upstream-credentials-list" class="credentials-list"></div>
          <div id="upstream-credentials-empty" class="empty muted" style="padding: 12px; text-align: center;">尚未配置多凭证，将使用上方默认 API Key。</div>
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
    <div id="task-detail-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">任务详情</div>
            <h3 id="task-detail-title">查看任务</h3>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div id="task-detail" class="task-detail-panel"></div>
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
          <label>图片生成模式<select id="model-image-mode"><option value="text-to-image">文生图</option><option value="image-to-image">图生图</option><option value="both">文生图 + 图生图</option></select></label>
          <label>模型状态<select id="model-status"><option value="active">启用</option><option value="hidden">隐藏</option><option value="disabled">停用</option></select></label>
          <label>流式<select id="model-stream"><option value="true">支持</option><option value="false">不支持</option></select></label>
          <label>优先级<input id="route-priority" type="number" value="1"></label>
          <label>价格<input id="model-price" placeholder="例如: 0.5"></label>
          <label>计费单位<select id="model-price-unit"><option value="per_1m_tokens">元 / 1M Token</option><option value="per_call">元 / 次</option></select></label>
          <label>所属上游<select id="model-upstream-select"></select></label>
        </div>
        <div class="actions" style="margin-top: 14px;"><button id="save-model-form" type="button">保存模型</button></div>
      </section>
    </div>
    <div id="model-group-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-modal-close></div>
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="model-group-modal-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow">模型分组</div>
            <h3 id="model-group-modal-title">添加分组</h3>
            <p class="subtitle">组别名不可与现有模型别名冲突；成员必须为同一模态。</p>
          </div>
          <button class="secondary compact" type="button" data-modal-close>关闭</button>
        </div>
        <div class="form-grid modal-form">
          <label>组别名<input id="group-alias" placeholder="tier:advanced 或自定义组名"></label>
          <label>显示名<input id="group-name" placeholder="高级模型组（可选）"></label>
          <label>分组级别<select id="group-level"><option value="advanced">advanced（高级）</option><option value="standard">standard（标准）</option><option value="basic">basic（基础）</option><option value="custom">custom（自定义）</option></select></label>
          <label>模态<select id="group-modality"><option value="text">文本</option><option value="image">图片</option><option value="video">视频</option><option value="file">文件</option></select></label>
          <label>状态<select id="group-status"><option value="active">启用</option><option value="disabled">停用</option></select></label>
          <label>回退成员<select id="group-fallback"><option value="">不指定</option></select></label>
        </div>
        <div style="margin-top: 14px;">
          <label>描述<input id="group-description" placeholder="分组说明（可选）"></label>
        </div>
        <div style="margin-top: 14px;">
          <div style="display:flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong>成员列表</strong>
            <button id="group-add-member" class="secondary compact" type="button">+ 添加成员</button>
          </div>
          <div id="group-members" class="stack"></div>
          <p class="subtitle" style="margin-top: 6px;">权重默认为 1，越大被选中概率越高；填 0 则跳过该成员。</p>
        </div>
        <div class="actions" style="margin-top: 14px;"><button id="save-group-form" type="button">保存分组</button></div>
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
      var state = { overview: null, config: null, models: [], selectedModelAlias: null, editingModelAlias: null, modelGroups: [], editingGroupAlias: null, users: [], apiKeys: [], usage: null, tasks: [] };
      var titles = { dashboard: '仪表盘', upstreams: '上游管理', models: '模型管理', 'model-groups': '模型分组', users: '用户管理', usage: '模型用量', tasks: '任务管理', config: '配置工具', settings: '站点设置' };
      var statusEl = document.getElementById('status');
      var lastAutoRefreshAt = Date.now();
      var savedTheme = localStorage.getItem('teaven_admin_theme');
      var theme = savedTheme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      setThemeToggleText(theme);

      document.getElementById('nav').addEventListener('click', function (event) {
        var link = event.target.closest('[data-section]');
        if (!link) return;
        showSection(link.getAttribute('data-section'));
        closeMobileNav();
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
      var sidebarCollapse = document.getElementById('sidebar-collapse');
      var mobileMenu = document.getElementById('mobile-menu');
      var mobileBackdrop = document.getElementById('mobile-backdrop');
      if (sidebarCollapse) sidebarCollapse.addEventListener('click', function () { document.getElementById('admin-layout').classList.toggle('collapsed'); });
      if (mobileMenu) mobileMenu.addEventListener('click', openMobileNav);
      if (mobileBackdrop) mobileBackdrop.addEventListener('click', closeMobileNav);
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
          if (localStorage.getItem('teaven_admin_theme')) return;
          document.documentElement.setAttribute('data-theme', event.matches ? 'dark' : 'light');
          setThemeToggleText(event.matches ? 'dark' : 'light');
        });
      }
      document.getElementById('open-upstream-modal').addEventListener('click', function () { resetUpstreamForm(); openModal('upstream-modal', 'upstream-modal-title', '添加上游'); });
      document.getElementById('open-model-modal').addEventListener('click', function () { resetModelForm(); openModal('model-modal', 'model-modal-title', '添加模型'); });
      document.getElementById('open-user-modal').addEventListener('click', function () { resetUserForm(); openModal('user-modal', 'user-modal-title', '添加用户'); });
      document.getElementById('save-model-form').addEventListener('click', saveModelFromForm);
      document.getElementById('model-modality').addEventListener('change', function () { toggleImageModeField(this.value); });
      document.getElementById('save-model-json').addEventListener('click', saveModelFromJson);
      document.getElementById('reset-models').addEventListener('click', resetModels);
      document.getElementById('open-group-modal').addEventListener('click', function () { resetGroupForm(); openModal('model-group-modal', 'model-group-modal-title', '添加分组'); });
      document.getElementById('init-default-groups').addEventListener('click', initDefaultGroups);
      document.getElementById('save-group-form').addEventListener('click', saveGroupFromForm);
      document.getElementById('group-add-member').addEventListener('click', function () { appendGroupMemberRow({ alias: '', weight: 1 }); refreshGroupFallbackOptions(); });
      document.getElementById('group-modality').addEventListener('change', function () { refreshGroupMemberOptions(); refreshGroupFallbackOptions(); });
      document.getElementById('model-groups-list').addEventListener('click', handleGroupAction);
      document.getElementById('group-members').addEventListener('click', function (event) {
        var remove = event.target.closest('[data-group-member-remove]');
        if (!remove) return;
        var row = remove.closest('[data-group-member-row]');
        if (row) row.remove();
        refreshGroupFallbackOptions();
      });
      document.getElementById('save-upstream-form').addEventListener('click', saveUpstreamFromForm);
      document.getElementById('reset-upstream-form').addEventListener('click', resetUpstreamForm);
      document.getElementById('create-user').addEventListener('click', createUser);
      document.getElementById('reveal-key-confirm').addEventListener('click', revealApiKey);
      document.getElementById('load-tasks').addEventListener('click', loadTasks);
      document.getElementById('fill-current-config').addEventListener('click', fillCurrentConfig);
      document.getElementById('validate-config').addEventListener('click', validateConfig);
      document.getElementById('save-settings').addEventListener('click', saveSettings);
      document.getElementById('clear-settings').addEventListener('click', clearSettings);
      document.getElementById('models-list').addEventListener('click', handleModelAction);
      document.getElementById('upstreams-list').addEventListener('click', handleUpstreamAction);
      document.getElementById('users-list').addEventListener('click', handleUserAction);
      document.getElementById('keys-list').addEventListener('click', handleKeyAction);
      document.getElementById('tasks-table').addEventListener('click', handleTaskAction);
      document.addEventListener('visibilitychange', refreshAfterTabSwitch);
      window.addEventListener('focus', refreshAfterTabSwitch);

      showSection((location.hash || '#dashboard').slice(1));
      loadAll();
      loadSettings();

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
          var results = await Promise.all([api('/admin/api/overview'), api('/admin/api/config'), api('/admin/api/models'), api('/admin/api/users'), api('/admin/api/usage'), api('/admin/api/tasks?limit=50'), api('/admin/api/model-groups')]);
          state.overview = results[0];
          state.config = results[1];
          state.models = results[2].data || [];
          state.users = results[3].users || [];
          state.apiKeys = results[3].api_keys || [];
          state.usage = results[4].usage;
          state.tasks = results[5].data || [];
          state.modelGroups = results[6].data || [];
          renderAll();
          setStatus('已刷新：' + new Date().toLocaleString(), 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      function refreshAfterTabSwitch() {
        if (document.visibilityState !== 'visible') return;
        var now = Date.now();
        if (now - lastAutoRefreshAt < 1000) return;
        lastAutoRefreshAt = now;
        loadAll();
      }

      function renderAll() {
        renderDashboard();
        renderUpstreamManagement();
        renderModels();
        renderModelGroups();
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
              (model.modality === 'image' ? '<div class="entity-row"><span>图片模式</span><strong>' + esc(imageModeText(model.image_mode)) + '</strong></div>' : '') +
              '<div class="entity-row"><span>流式</span><strong>' + (model.supports_stream !== false ? '支持' : '不支持') + '</strong></div>' +
              '<div class="entity-row"><span>价格</span><strong>' + priceText(model.price, model.price_unit) + '</strong></div>' +
              '<div class="entity-row"><span>路由</span><div>' + routes + '</div></div>' +
            '</div>' +
            '<div class="actions entity-actions"><button type="button" class="secondary compact" data-model-view="' + esc(model.alias) + '">查看</button><button type="button" class="secondary compact" data-model-edit="' + esc(model.alias) + '">编辑</button><button type="button" class="danger compact" data-model-delete="' + esc(model.alias) + '">删除</button></div>' +
          '</article>';
        }).join('') : '<div class="empty">暂无模型。</div>';
        if (state.models[0] && !document.getElementById('model-json').value.trim()) fillModelEditor(state.models[0].alias, false);
        renderModelDetail();
      }

      function renderModelDetail() {
        var detail = document.getElementById('model-detail-content');
        var json = document.getElementById('model-detail-json');
        if (!state.selectedModelAlias) {
          detail.innerHTML = '<div class="empty">点击模型列表中的“查看”显示模型信息。</div>';
          json.style.display = 'none';
          json.textContent = '';
          return;
        }

        var model = state.models.find(function (item) { return item.alias === state.selectedModelAlias; });
        if (!model) {
          detail.innerHTML = '<div class="empty">未找到模型：<code>' + esc(state.selectedModelAlias) + '</code></div>';
          json.style.display = 'none';
          json.textContent = '';
          return;
        }

        detail.innerHTML = renderModelDetailContent(model);
        json.style.display = 'block';
        json.textContent = JSON.stringify(model, null, 2);
      }

      function renderModelDetailContent(model) {
        var providers = (state.overview && state.overview.providers) || [];
        var routeRows = (model.routes || []).length ? (model.routes || []).map(function (route) {
          var plugin = findProvider(providers, route.plugin_id);
          return '<tr><td><code>' + esc(route.upstream_name || route.upstream_id || '未配置') + '</code></td><td><code>' + esc(route.provider_model || '') + '</code></td><td>' + esc(plugin ? plugin.name : route.plugin_id) + '</td><td><span class="pill ' + (route.credential_configured ? 'ok' : 'danger') + '">' + (route.credential_configured ? '已配置' : '缺少') + '</span></td><td><span class="pill ' + statusClass(route.status) + '">' + esc(statusText(route.status)) + '</span></td><td>' + esc(route.priority == null ? '未设置' : route.priority) + '</td><td>' + esc(route.weight == null ? '未设置' : route.weight) + '</td></tr>';
        }).join('') : '<tr><td colspan="7" class="empty">暂无路由。</td></tr>';
        return '<div class="entity-meta">' +
          '<div class="entity-row"><span>别名</span><code>' + esc(model.alias) + '</code></div>' +
          '<div class="entity-row"><span>模态</span><strong>' + esc(modalityText(model.modality)) + '</strong></div>' +
          (model.modality === 'image' ? '<div class="entity-row"><span>图片模式</span><strong>' + esc(imageModeText(model.image_mode)) + '</strong></div>' : '') +
          '<div class="entity-row"><span>状态</span><span class="pill ' + statusClass(model.status) + '">' + esc(statusText(model.status)) + '</span></div>' +
          '<div class="entity-row"><span>流式</span><strong>' + (model.supports_stream !== false ? '支持' : '不支持') + '</strong></div>' +
          '<div class="entity-row"><span>价格</span><strong>' + priceText(model.price, model.price_unit) + '</strong></div>' +
          '<div class="entity-row"><span>路由数</span><strong>' + esc((model.routes || []).length) + '</strong></div>' +
        '</div>' +
        '<div><h3>路由明细</h3><div class="table-wrap"><table><thead><tr><th>上游</th><th>上游模型</th><th>插件</th><th>API Key</th><th>状态</th><th>优先级</th><th>权重</th></tr></thead><tbody>' + routeRows + '</tbody></table></div></div>' +
        '<div class="status">下方 JSON 为当前模型完整信息。</div>';
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
            '<header><div class="entity-title"><strong>' + esc(user.name || user.id) + '</strong><div class="status">' + esc(user.email) + '</div></div><span class="pill ' + statusClass(user.status) + '">' + esc(statusText(user.status)) + '</span></header>' +
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
          return '<tr><td><code>' + esc(task.id) + '</code></td><td>' + esc(taskTypeText(task.type)) + '</td><td>' + esc(task.model) + '</td><td><span class="pill ' + statusClass(task.status) + '">' + esc(statusText(task.status)) + '</span></td><td class="time-cell">' + esc(formatDate(task.created_at)) + '</td><td><div class="actions">' + actions + '</div></td></tr>';
        }).join('') : '<tr><td colspan="6" class="empty">暂无任务。</td></tr>';
      }

      function renderTaskDetail(task) {
        return '<div class="task-detail-card">' +
          '<div class="task-detail-grid">' +
            taskDetailItem('任务 ID', task.id, true) +
            taskDetailItem('组织', task.organization_id || '-', true) +
            taskDetailItem('API Key', task.api_key_id || '-', true) +
            taskDetailItem('类型', taskTypeText(task.type), false) +
            taskDetailItem('模型', task.model || '-', false) +
            '<div><span class="muted-label">状态</span><div><span class="pill ' + statusClass(task.status) + '">' + esc(statusText(task.status)) + '</span></div></div>' +
            taskDetailItem('上游', task.upstream_id || '-', false) +
            taskDetailItem('Provider', task.plugin_id || '-', false) +
            taskDetailItem('Provider 任务 ID', task.provider_task_id || '-', true) +
            taskDetailItem('存储输出', task.store_output ? '是' : '否', false) +
            taskDetailItem('存储 TTL', task.storage_ttl_seconds == null ? '-' : task.storage_ttl_seconds + ' 秒', false) +
            taskDetailItem('回调 URL', task.callback_url || '未设置', false) +
            taskDetailItem('创建时间', formatDate(task.created_at), false) +
            taskDetailItem('更新时间', formatDate(task.updated_at), false) +
            taskDetailItem('完成时间', task.completed_at ? formatDate(task.completed_at) : '-', false) +
          '</div>' +
          renderTaskDiagnostics(task.diagnostics) +
          renderTaskEvents(task.events || []) +
          renderTaskJsonSection('输入参数', task.input, false) +
          renderTaskOutputPreview(task) +
          renderTaskJsonSection('错误信息', task.error, true) +
          renderTaskJsonSection('元数据', task.metadata, false) +
        '</div>';
      }

      function taskDetailItem(label, value, code) {
        var content = code ? '<code class="break-all">' + esc(value) + '</code>' : '<span class="break-all">' + esc(value) + '</span>';
        return '<div><span class="muted-label">' + esc(label) + '</span><div>' + content + '</div></div>';
      }

      function renderTaskDiagnostics(diagnostics) {
        if (!diagnostics) return '';
        var items = [
          ['轮询次数', diagnostics.poll_count == null ? 0 : diagnostics.poll_count],
          ['创建尝试', diagnostics.create_attempt_count == null ? 0 : diagnostics.create_attempt_count],
          ['上游状态', providerStatusText(diagnostics.provider_status)],
          ['上游业务码', diagnostics.provider_response_code || '-'],
          ['上游 HTTP', diagnostics.provider_http_status || '-'],
          ['最后轮询', diagnostics.last_poll_at ? formatDate(diagnostics.last_poll_at) : '-'],
          ['下次轮询', diagnostics.next_poll_at ? formatDate(diagnostics.next_poll_at) : '-'],
          ['最近错误', diagnostics.last_error ? formatDiagnosticValue(diagnostics.last_error) : '-']
        ];
        return '<div><span class="muted-label">诊断摘要</span><div class="task-diagnostics">' + items.map(function (item) { return '<div><span class="muted-label">' + esc(item[0]) + '</span><div class="break-all">' + esc(String(item[1])) + '</div></div>'; }).join('') + '</div></div>';
      }

      function renderTaskEvents(events) {
        if (!events.length) return '<div><span class="muted-label">状态链</span><div class="empty">暂无状态事件。</div></div>';
        var cols = '<colgroup><col style="width:170px"><col style="width:150px"><col style="width:96px"><col style="width:110px"><col></colgroup>';
        var rows = events.map(function (event) { return '<tr><td class="time-cell">' + esc(formatDate(event.at)) + '</td><td>' + esc(stageText(event.stage) || '-') + '</td><td>' + esc(statusText(event.status) || '-') + '</td><td>' + esc(providerStatusText(event.provider_status)) + '</td><td>' + esc(formatTaskEventSummary(event)) + '</td></tr>'; }).join('');
        return '<div><span class="muted-label">状态链</span><div class="task-events-scroll"><table class="task-events-table">' + cols + '<thead><tr><th>时间</th><th>阶段</th><th>平台状态</th><th>上游状态</th><th>摘要</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      }

      function renderTaskJsonSection(label, value, danger) {
        if (!value) return '';
        var content = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        var style = danger ? ' style="border-color:var(--danger);color:var(--danger);background:rgba(251,113,133,0.05);"' : '';
        return '<div><span class="muted-label"' + (danger ? ' style="color:var(--danger);"' : '') + '>' + esc(label) + '</span><pre class="task-json-block"' + style + '>' + esc(content) + '</pre></div>';
      }

      function renderTaskOutputPreview(task) {
        if (!task.output) return '';

        var output = Array.isArray(task.output) ? task.output : [];
        var images = output.filter(function (item) { return item && (item.url || item.b64_json); });

        var html = '<div><span class="muted-label">输出结果</span>';

        if (images.length > 0) {
          html += '<div class="image-preview-grid" style="margin-top:4px;">' +
            images.map(function (item, index) {
              var src = imageOutputSrc(item);
              var label = item.stored ? '已转存' : (item.source === 'upstream' ? '上游 URL' : '图片');
              var openLink = item.url ? '<a href="' + esc(item.url) + '" target="_blank" rel="noreferrer">打开原图</a>' : '<span class="muted">Base64</span>';
              return '<article class="image-preview-card"><img src="' + esc(src) + '" alt="生成图片 ' + (index + 1) + '" loading="lazy"><footer><span>' + esc(label) + ' #' + (index + 1) + '</span>' + openLink + '</footer></article>';
            }).join('') +
            '</div>';
        }

        var content = typeof task.output === 'object' ? JSON.stringify(task.output, null, 2) : String(task.output);
        html += '<pre class="task-json-block" style="margin-top:' + (images.length > 0 ? '8' : '4') + 'px;">' + esc(content) + '</pre></div>';

        return html;
      }

      function imageOutputSrc(item) {
        if (item.url) return item.url;
        var value = String(item.b64_json || '');
        return value.startsWith('data:') ? value : 'data:image/png;base64,' + value;
      }

      function formatTaskEventSummary(event) {
        var parts = [];
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
          return Object.keys(value).reduce(function (result, key) {
            result[diagnosticKeyText(key)] = localizeDiagnosticValue(value[key]);
            return result;
          }, {});
        }
        if (typeof value === 'string') return translateDiagnosticText(value);
        return value;
      }

      function diagnosticKeyText(key) {
        var map = {
          message: '消息', cause: '原因', error: '错误', errors: '错误列表', response: '响应', data: '数据', code: '业务码', status: '状态', type: '类型', id: 'ID', task_id: '任务 ID', provider_task_id: '上游任务 ID', provider_status: '上游状态', provider_response_code: '上游业务码', provider_http_status: '上游 HTTP', http_status: 'HTTP 状态', output_count: '输出数量', stored_count: '已存储数量', output_expires_at: '输出过期时间', poll_count: '轮询次数', poll_url: '轮询 URL', upstream_raw_body: '上游原始响应', raw_body: '原始响应', attempt: '尝试次数', delay_seconds: '延迟秒数', process_id: '处理进程', request_id: '请求 ID'
        };
        return map[key] || key;
      }

      function translateDiagnosticText(text) {
        if (text === null || text === undefined) return '-';
        var value = String(text);
        var map = {
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
        var matched = value.match(/^Exceeded max poll attempts \\((\\d+)\\)$/);
        if (matched) return '已超过最大轮询次数（' + matched[1] + '）';
        matched = value.match(/^Upstream task creation failed after (\\d+) attempts$/);
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

      function renderConfig() {
        var config = state.config || {};
        document.getElementById('current-config').textContent = config.config_json || '';
        document.getElementById('config-json').value = document.getElementById('config-json').value || config.config_json || '';
        document.getElementById('example-request').textContent = renderExample(config.example_chat_request);
      }

      async function saveModelFromForm() {
        var upstream_id = document.getElementById('model-upstream-select').value;
        if (!upstream_id) { setStatus('请先选择所属上游', 'error'); return; }
        var modality = value('model-modality');
        var model = { upstream_id: upstream_id, alias: value('model-alias'), provider_model: value('route-provider-model'), modality: modality, supports_stream: value('model-stream') === 'true', image_mode: modality === 'image' ? value('model-image-mode') : undefined, status: value('model-status'), priority: Number(value('route-priority') || 1), weight: 100, price: value('model-price'), price_unit: value('model-price-unit') };
        await saveModel(model, state.editingModelAlias);
        closeModal('model-modal');
      }
      async function saveModelFromJson() { var model = JSON.parse(document.getElementById('model-json').value); await saveModel(model, model.original_alias || state.editingModelAlias || null); }
      async function saveModel(model, originalAlias) { var path = originalAlias ? '/admin/api/models/' + encodeURIComponent(originalAlias) : '/admin/api/models'; var method = originalAlias ? 'PUT' : 'POST'; await api(path, { method: method, body: JSON.stringify({ model: model }) }); state.editingModelAlias = null; await loadAll(); setStatus('模型已保存：' + model.alias, 'ok'); }
      async function resetModels() { if (!confirm('确定重置模型配置？')) return; await api('/admin/api/models/reset', { method: 'POST' }); document.getElementById('model-json').value = ''; await loadAll(); setStatus('模型配置已重置。', 'ok'); }

      // ── 模型分组 ──
      function levelText(level) {
        return level === 'advanced' ? '高级' : level === 'standard' ? '标准' : level === 'basic' ? '基础' : '自定义';
      }
      function levelPillClass(level) {
        return level === 'advanced' ? 'ok' : level === 'standard' ? 'warn' : level === 'basic' ? 'muted' : '';
      }
      function renderModelGroups() {
        var list = document.getElementById('model-groups-list');
        var groups = state.modelGroups || [];
        if (!groups.length) {
          list.innerHTML = '<div class="empty">尚未配置模型分组。点击「初始化默认三组」可一键创建高级/标准/基础三组骨架。</div>';
          return;
        }
        list.innerHTML = groups.map(function (group) {
          var memberBadges = group.members.map(function (m) {
            var weightText = m.weight !== undefined && m.weight !== 1 ? ' ×' + esc(String(m.weight)) : '';
            var unavailable = m.available === false ? ' style="opacity:0.5; text-decoration: line-through;" title="模型不存在或已禁用"' : '';
            return '<span class="pill"' + unavailable + '>' + esc(m.alias) + weightText + '</span>';
          }).join('');
          var fallbackText = group.fallback_member_alias ? '回退 ' + esc(group.fallback_member_alias) : '无回退';
          return '<article class="entity-card">' +
            '<header><div><div class="eyebrow">' + esc(group.alias) + '</div>' +
            '<h4>' + esc(group.name || group.alias) + '</h4>' +
            '<p class="subtitle">' + esc(group.description || '') + '</p></div>' +
            '<div class="actions"><button class="secondary compact" data-group-edit="' + esc(group.alias) + '">编辑</button>' +
            '<button class="danger compact" data-group-delete="' + esc(group.alias) + '">删除</button></div></header>' +
            '<div class="meta-row">' +
              '<span class="pill ' + levelPillClass(group.level) + '">' + levelText(group.level) + '</span>' +
              '<span class="pill">' + esc(group.modality) + '</span>' +
              '<span class="pill ' + (group.status === 'active' ? 'ok' : 'muted') + '">' + (group.status === 'active' ? '启用' : '停用') + '</span>' +
              '<span class="muted-label">成员 ' + group.members_count + ' · ' + fallbackText + '</span>' +
            '</div>' +
            '<div class="meta-row">' + (memberBadges || '<span class="muted-label">无成员</span>') + '</div>' +
          '</article>';
        }).join('');
      }

      function resetGroupForm() {
        state.editingGroupAlias = null;
        document.getElementById('group-alias').value = '';
        document.getElementById('group-alias').disabled = false;
        document.getElementById('group-name').value = '';
        document.getElementById('group-level').value = 'advanced';
        document.getElementById('group-modality').value = 'text';
        document.getElementById('group-status').value = 'active';
        document.getElementById('group-description').value = '';
        document.getElementById('group-members').innerHTML = '';
        refreshGroupMemberOptions();
        refreshGroupFallbackOptions();
      }

      function fillGroupForm(group) {
        state.editingGroupAlias = group.alias;
        document.getElementById('group-alias').value = group.alias;
        document.getElementById('group-alias').disabled = false;
        document.getElementById('group-name').value = group.name || '';
        document.getElementById('group-level').value = group.level;
        document.getElementById('group-modality').value = group.modality;
        document.getElementById('group-status').value = group.status || 'active';
        document.getElementById('group-description').value = group.description || '';
        var container = document.getElementById('group-members');
        container.innerHTML = '';
        (group.members || []).forEach(function (m) { appendGroupMemberRow(m); });
        refreshGroupMemberOptions();
        refreshGroupFallbackOptions();
      }

      function appendGroupMemberRow(member) {
        var container = document.getElementById('group-members');
        var row = document.createElement('div');
        row.setAttribute('data-group-member-row', '');
        row.className = 'form-grid';
        row.style.gridTemplateColumns = '1fr 120px auto';
        row.innerHTML =
          '<label>成员别名<select class="group-member-alias"></select></label>' +
          '<label>权重<input type="number" class="group-member-weight" min="0" step="1" value="' + esc(String(member.weight !== undefined ? member.weight : 1)) + '"></label>' +
          '<button class="danger compact" type="button" data-group-member-remove>移除</button>';
        container.appendChild(row);
        var aliasSelect = row.querySelector('.group-member-alias');
        var modality = document.getElementById('group-modality').value;
        var candidates = (state.models || []).filter(function (m) { return m.modality === modality; });
        var current = member.alias || '';
        aliasSelect.innerHTML = candidates.map(function (m) {
          var selected = m.alias === current ? ' selected' : '';
          return '<option value="' + esc(m.alias) + '"' + selected + '>' + esc(m.alias) + '</option>';
        }).join('');
        if (current && !candidates.some(function (m) { return m.alias === current; })) {
          aliasSelect.innerHTML = '<option value="' + esc(current) + '" selected>' + esc(current) + '（不在可选列表）</option>' + aliasSelect.innerHTML;
        }
        aliasSelect.addEventListener('change', refreshGroupFallbackOptions);
      }

      function refreshGroupMemberOptions() {
        var modality = document.getElementById('group-modality').value;
        var candidates = (state.models || []).filter(function (m) { return m.modality === modality; });
        document.querySelectorAll('#group-members .group-member-alias').forEach(function (sel) {
          var current = sel.value;
          sel.innerHTML = candidates.map(function (m) {
            var selected = m.alias === current ? ' selected' : '';
            return '<option value="' + esc(m.alias) + '"' + selected + '>' + esc(m.alias) + '</option>';
          }).join('');
          if (current && !candidates.some(function (m) { return m.alias === current; })) {
            sel.innerHTML = '<option value="' + esc(current) + '" selected>' + esc(current) + '（不在可选列表）</option>' + sel.innerHTML;
          }
        });
      }

      function refreshGroupFallbackOptions() {
        var select = document.getElementById('group-fallback');
        var current = select.value;
        var aliases = collectGroupMemberAliases();
        select.innerHTML = '<option value="">不指定</option>' + aliases.map(function (alias) {
          return '<option value="' + esc(alias) + '"' + (alias === current ? ' selected' : '') + '>' + esc(alias) + '</option>';
        }).join('');
      }

      function collectGroupMemberAliases() {
        return Array.from(document.querySelectorAll('#group-members .group-member-alias')).map(function (sel) { return sel.value; }).filter(Boolean);
      }

      function collectGroupMembers() {
        var rows = document.querySelectorAll('#group-members [data-group-member-row]');
        var members = [];
        rows.forEach(function (row) {
          var alias = row.querySelector('.group-member-alias').value;
          var weightRaw = row.querySelector('.group-member-weight').value;
          if (!alias) return;
          var weight = weightRaw === '' ? undefined : Number(weightRaw);
          members.push({ alias: alias, weight: weight });
        });
        return members;
      }

      async function saveGroupFromForm() {
        var alias = document.getElementById('group-alias').value.trim();
        if (!alias) { setStatus('组别名不能为空', 'error'); return; }
        var group = {
          alias: alias,
          name: document.getElementById('group-name').value.trim() || undefined,
          level: document.getElementById('group-level').value,
          modality: document.getElementById('group-modality').value,
          status: document.getElementById('group-status').value,
          description: document.getElementById('group-description').value.trim() || undefined,
          fallback_member_alias: document.getElementById('group-fallback').value || undefined,
          members: collectGroupMembers()
        };
        if (!group.members.length) { setStatus('至少需要一个成员', 'error'); return; }
        try {
          var path = state.editingGroupAlias ? '/admin/api/model-groups/' + encodeURIComponent(state.editingGroupAlias) : '/admin/api/model-groups';
          var method = state.editingGroupAlias ? 'PUT' : 'POST';
          await api(path, { method: method, body: JSON.stringify({ group: group }) });
          state.editingGroupAlias = null;
          await loadAll();
          setStatus('分组已保存：' + group.alias, 'ok');
          closeModal('model-group-modal');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      async function initDefaultGroups() {
        if (!confirm('初始化默认三组（tier:advanced / tier:standard / tier:basic）？已存在的默认组将被跳过，未存在的会用所有同模态模型作为初始成员创建。')) return;
        try {
          var data = await api('/admin/api/model-groups/init-defaults', { method: 'POST' });
          await loadAll();
          var msg = '已创建：' + (data.created && data.created.length ? data.created.join(', ') : '无') + '；跳过：' + (data.skipped && data.skipped.length ? data.skipped.join(', ') : '无');
          setStatus(msg, 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      async function handleGroupAction(event) {
        var editBtn = event.target.closest('[data-group-edit]');
        if (editBtn) {
          var alias = editBtn.getAttribute('data-group-edit');
          var group = (state.modelGroups || []).find(function (g) { return g.alias === alias; });
          if (!group) return;
          fillGroupForm(group);
          openModal('model-group-modal', 'model-group-modal-title', '编辑分组');
          return;
        }
        var delBtn = event.target.closest('[data-group-delete]');
        if (delBtn) {
          var delAlias = delBtn.getAttribute('data-group-delete');
          if (!confirm('确定删除分组 ' + delAlias + '？')) return;
          try {
            await api('/admin/api/model-groups/' + encodeURIComponent(delAlias), { method: 'DELETE' });
            await loadAll();
            setStatus('分组已删除：' + delAlias, 'ok');
          } catch (error) {
            setStatus(error.message || String(error), 'error');
          }
        }
      }

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
        state.editingModelAlias = null;
        document.getElementById('model-alias').value = '';
        document.getElementById('route-provider-model').value = '';
        document.getElementById('model-modality').value = 'text';
        toggleImageModeField('text');
        document.getElementById('model-image-mode').value = 'text-to-image';
        document.getElementById('model-status').value = 'active';
        document.getElementById('model-stream').value = 'true';
        document.getElementById('route-priority').value = '1';
        document.getElementById('model-price').value = '';
        document.getElementById('model-price-unit').value = 'per_1m_tokens';
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

      async function loadSettings() {
        try {
          var data = await api('/admin/api/settings');
          document.getElementById('settings-env-base-url').value = data.settings.env_files_public_base_url || '';
          document.getElementById('settings-files-base-url').value = data.settings.files_public_base_url || '';
          document.getElementById('settings-output').textContent = JSON.stringify(data.settings, null, 2);
          setSettingsMessage('', '');
        } catch (error) {
          document.getElementById('settings-output').textContent = '加载失败：' + (error.message || String(error));
          setSettingsMessage('加载设置失败：' + (error.message || String(error)), 'error');
        }
      }

      async function saveSettings() {
        var baseUrl = document.getElementById('settings-files-base-url').value.trim();
        try {
          var data = await api('/admin/api/settings', {
            method: 'PUT',
            body: JSON.stringify({ files_public_base_url: baseUrl || null })
          });
          document.getElementById('settings-env-base-url').value = data.settings.env_files_public_base_url || '';
          document.getElementById('settings-files-base-url').value = data.settings.files_public_base_url || '';
          document.getElementById('settings-output').textContent = JSON.stringify(data.settings, null, 2);
          setSettingsMessage('保存成功，新的文件域名设置已生效。', 'ok');
          setStatus('站点设置已保存。', 'ok');
        } catch (error) {
          document.getElementById('settings-output').textContent = '保存失败：' + (error.message || String(error));
          setSettingsMessage('保存失败：' + (error.message || String(error)), 'error');
          setStatus('保存站点设置失败：' + (error.message || String(error)), 'error');
        }
      }

      async function clearSettings() {
        try {
          var data = await api('/admin/api/settings', {
            method: 'PUT',
            body: JSON.stringify({ files_public_base_url: null })
          });
          document.getElementById('settings-files-base-url').value = '';
          document.getElementById('settings-output').textContent = JSON.stringify(data.settings, null, 2);
          setSettingsMessage('已清除自定义域名，将回退到环境变量或 Worker 代理。', 'warn');
          setStatus('自定义域名已清除。', 'ok');
        } catch (error) {
          document.getElementById('settings-output').textContent = '清除失败：' + (error.message || String(error));
          setSettingsMessage('清除失败：' + (error.message || String(error)), 'error');
          setStatus('清除自定义域名失败：' + (error.message || String(error)), 'error');
        }
      }

      function setSettingsMessage(message, type) {
        var el = document.getElementById('settings-message');
        if (!el) return;
        el.textContent = message || '';
        el.className = message ? 'settings-message ' + type : 'settings-message';
      }

      async function handleModelAction(event) {
        var view = event.target.closest('[data-model-view]'); var edit = event.target.closest('[data-model-edit]'); var del = event.target.closest('[data-model-delete]');
        if (view) { viewModel(view.getAttribute('data-model-view')); return; }
        if (edit) { fillModelEditor(edit.getAttribute('data-model-edit'), true); openModal('model-modal', 'model-modal-title', '编辑模型'); }
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
      async function handleTaskAction(event) {
        var view = event.target.closest('[data-task-view]');
        var cancel = event.target.closest('[data-task-cancel]');
        if (view) {
          var taskId = view.getAttribute('data-task-view');
          setStatus('正在加载任务详情...', '');
          try {
            var detail = await api('/admin/api/tasks/' + encodeURIComponent(taskId));
            document.getElementById('task-detail').innerHTML = renderTaskDetail(detail.task);
            document.getElementById('task-detail-title').textContent = '任务 ' + taskId;
            openModal('task-detail-modal', 'task-detail-title', '任务 ' + taskId);
            setStatus('任务详情已加载', 'ok');
          } catch (error) {
            setStatus('加载任务详情失败: ' + (error.message || String(error)), 'error');
          }
          return;
        }
        if (cancel && confirm('确定取消任务？')) {
          await api('/admin/api/tasks/' + encodeURIComponent(cancel.getAttribute('data-task-cancel')) + '/cancel', { method: 'POST' });
          await loadTasks();
        }
      }

      function fillModelEditor(alias, editing) { var model = state.models.find(function (item) { return item.alias === alias; }); if (!model) return; state.editingModelAlias = editing ? alias : null; var route = model.routes && model.routes[0] ? model.routes[0] : {}; document.getElementById('model-json').value = JSON.stringify(toModelInput(model), null, 2); document.getElementById('model-alias').value = model.alias; document.getElementById('model-modality').value = model.modality; toggleImageModeField(model.modality); document.getElementById('model-image-mode').value = model.image_mode || 'text-to-image'; document.getElementById('model-status').value = model.status; document.getElementById('model-stream').value = String(model.supports_stream !== false); var select = document.getElementById('model-upstream-select'); if (select.options.length > 1) { select.value = route.upstream_id || ''; } document.getElementById('route-provider-model').value = route.provider_model || ''; document.getElementById('route-priority').value = route.priority || 1; document.getElementById('model-price').value = model.price || ''; document.getElementById('model-price-unit').value = model.price_unit || 'per_1m_tokens'; }
      function viewModel(alias) { state.selectedModelAlias = alias; renderModelDetail(); setStatus('正在查看模型：' + alias, 'ok'); }
      function toModelInput(model) { var route = model.routes && model.routes[0] ? model.routes[0] : {}; return { original_alias: model.alias, upstream_id: route.upstream_id, alias: model.alias, provider_model: route.provider_model, modality: model.modality, supports_stream: model.supports_stream, image_mode: model.image_mode || null, status: model.status, priority: route.priority, weight: route.weight, price: model.price || '', price_unit: model.price_unit || '' }; }
      function fillUpstreamEditor(id) { var upstreams = (state.overview && state.overview.upstreams) || []; var upstream = upstreams.find(function (item) { return item.id === id; }); if (!upstream) return; document.getElementById('upstream-admin-id').value = upstream.id || ''; document.getElementById('upstream-admin-name').value = upstream.name || ''; document.getElementById('upstream-admin-plugin').value = upstream.plugin_id || ''; document.getElementById('upstream-admin-base-url').value = upstream.base_url || ''; document.getElementById('upstream-admin-credential').value = upstream.credential_id || ''; document.getElementById('upstream-admin-status').value = upstream.status || 'active'; }
      function viewUpstream(id) { var upstream = findOverviewUpstream(id); if (!upstream) { setStatus('未找到上游：' + id, 'error'); return; } var raw = findConfigUpstream(id) || upstream; var name = upstream.name || upstream.id; document.getElementById('upstream-view-title').textContent = '查看上游：' + name; document.getElementById('upstream-view-content').innerHTML = renderUpstreamDetail(upstream, raw); document.getElementById('upstream-view-json').textContent = JSON.stringify(toUpstreamDetailJson(upstream, raw), null, 2); openModal('upstream-view-modal', 'upstream-view-title', '查看上游：' + name); }
      function renderUpstreamDetail(upstream, raw) { var providers = (state.overview && state.overview.providers) || []; var plugin = findProvider(providers, upstream.plugin_id); var models = (raw && raw.models) || upstream.models || []; var modelRows = models.length ? models.map(function (model) { return '<tr><td><code>' + esc(model.alias) + '</code></td><td><code>' + esc(model.provider_model) + '</code></td><td>' + esc(modalityText(model.modality)) + '</td><td>' + (model.modality === 'image' ? esc(imageModeText(model.image_mode)) : '-') + '</td><td><span class="pill ' + statusClass(model.status || 'active') + '">' + esc(statusText(model.status || 'active')) + '</span></td><td>' + (model.supports_stream !== false ? '支持' : '不支持') + '</td><td>' + esc(model.priority == null ? '未设置' : model.priority) + '</td><td>' + esc(model.weight == null ? '未设置' : model.weight) + '</td><td>' + priceText(model.price, model.price_unit) + '</td></tr>'; }).join('') : '<tr><td colspan="9" class="empty">暂无模型。</td></tr>'; return '<div class="entity-meta">' +
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
        '<div><h3>模型明细</h3><div class="table-wrap"><table><thead><tr><th>别名</th><th>上游模型</th><th>模态</th><th>图片模式</th><th>状态</th><th>流式</th><th>优先级</th><th>权重</th><th>价格</th></tr></thead><tbody>' + modelRows + '</tbody></table></div></div>' +
        '<div class="status">下方 JSON 为当前上游完整配置。</div>'; }
      function toUpstreamDetailJson(upstream, raw) { return Object.assign({}, raw || {}, { credential_configured: upstream.credential_configured, models_total: upstream.models_total, models_active: upstream.models_active, routes_active: upstream.routes_active == null ? 0 : upstream.routes_active }); }
      function findOverviewUpstream(id) { var upstreams = (state.overview && state.overview.upstreams) || []; return upstreams.find(function (item) { return item.id === id; }) || null; }
      function findConfigUpstream(id) { var upstreams = (state.config && state.config.config && state.config.config.upstreams) || []; return upstreams.find(function (item) { return item.id === id; }) || null; }
      function openModal(id, titleId, title) { var modal = document.getElementById(id); if (!modal) return; document.getElementById(titleId).textContent = title; modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.classList.add('modal-open'); var firstField = modal.querySelector('.modal-form input:not([type="hidden"]), .modal-form select, .modal-form textarea'); if (firstField) firstField.focus(); }
      function closeModal(id) { var modals = id ? [document.getElementById(id)] : Array.prototype.slice.call(document.querySelectorAll('.modal.open')); modals.forEach(function (modal) { if (!modal) return; modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }); if (!document.querySelector('.modal.open')) document.body.classList.remove('modal-open'); }
      function showSection(section) { section = titles[section] ? section : 'dashboard'; document.querySelectorAll('.section').forEach(function (el) { el.classList.toggle('active', el.id === section); }); document.querySelectorAll('.nav a').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-section') === section); }); document.getElementById('page-title').textContent = titles[section]; var breadcrumb = document.getElementById('breadcrumb-section'); if (breadcrumb) breadcrumb.textContent = titles[section]; }
      function toggleTheme() { var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('teaven_admin_theme', next); setThemeToggleText(next); }
      function setThemeToggleText(theme) { document.getElementById('theme-toggle').innerHTML = '<i class="ri-contrast-2-line"></i><span>' + (theme === 'dark' ? '切换浅色' : '切换深色') + '</span>'; }
      function openMobileNav() { document.getElementById('sidebar').classList.add('open'); document.getElementById('mobile-backdrop').classList.add('open'); document.body.classList.add('drawer-open'); }
      function closeMobileNav() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('mobile-backdrop').classList.remove('open'); document.body.classList.remove('drawer-open'); }
      function stat(label, value) { return '<div class="stat"><strong>' + esc(value == null ? 0 : value) + '</strong><span>' + esc(label) + '</span></div>'; }
      function meta(label, value) { return '<div><span class="pill">' + esc(label) + '</span><strong>' + esc(value == null ? '' : value) + '</strong></div>'; }
      function renderExample(req) { if (!req) return '暂无示例'; var quote = String.fromCharCode(39); return 'curl -X ' + req.method + ' "' + location.origin + req.endpoint + '"\\n  -H "Authorization: Bearer <DEV_API_KEY>"\\n  -H "Content-Type: application/json"\\n  -d ' + quote + JSON.stringify(req.body, null, 2) + quote; }
      function value(id) { return document.getElementById(id).value.trim(); }
      function yesNo(value) { return value ? '已绑定' : '未绑定'; }
      function taskStoreText(value) { return value === 'kv' ? 'KV' : value === 'memory' ? '内存' : value; }
      function priceText(price, unit) { if (!price) return '未设置'; var p = esc(price); if (unit === 'per_call') return p + ' 元 / 次'; return p + ' 元 / 1M Token'; }
      function modalityText(value) { if (value === 'text') return '文本'; if (value === 'image') return '图片'; if (value === 'video') return '视频'; if (value === 'file') return '文件'; if (value === 'vision') return '视觉'; if (value === 'audio') return '音频'; return value; }
      function imageModeText(value) { if (value === 'text-to-image') return '文生图'; if (value === 'image-to-image') return '图生图'; if (value === 'both') return '文生图 + 图生图'; return value || '未设置'; }
      function toggleImageModeField(modality) { var row = document.getElementById('model-image-mode'); if (!row) return; var label = row.closest('label'); if (!label) return; label.style.display = modality === 'image' ? '' : 'none'; }
      function roleText(value) { if (value === 'owner') return '所有者'; if (value === 'admin') return '管理员'; if (value === 'member') return '成员'; return value; }
      function taskTypeText(value) { if (value === 'chat' || value === 'chat.completions') return '聊天补全'; if (value === 'responses') return '响应生成'; if (value === 'image' || value === 'image_generation' || value === 'image.generation' || value === 'image.generations' || value === 'images.generations') return '图片生成'; if (value === 'video' || value === 'video_generation' || value === 'video.generation' || value === 'video.generations' || value === 'videos.generations') return '视频生成'; if (value === 'speech' || value === 'audio.speech') return '语音合成'; if (value === 'transcriptions' || value === 'audio.transcriptions') return '语音转写'; if (value === 'translations' || value === 'audio.translations') return '语音翻译'; if (value === 'file' || value === 'file.processing') return '文件处理'; if (value === 'embeddings') return '向量嵌入'; return value ? '未知类型：' + value : '未知类型'; }
      function statusText(status) { if (status === 'active') return '启用'; if (status === 'degraded') return '降级'; if (status === 'hidden') return '隐藏'; if (status === 'disabled') return '停用'; if (status === 'queued') return '排队中'; if (status === 'running') return '运行中'; if (status === 'succeeded') return '成功'; if (status === 'failed') return '失败'; if (status === 'canceled') return '已取消'; if (status === 'expired') return '已过期'; if (status === 'ok') return '正常'; if (status === 'warning') return '警告'; if (status === 'error') return '异常'; return status; }
      function statusClass(status) { if (status === 'active' || status === 'succeeded' || status === 'running' || status === 'ok') return 'ok'; if (status === 'queued' || status === 'hidden' || status === 'degraded' || status === 'warning') return 'warn'; if (status === 'disabled' || status === 'failed' || status === 'canceled' || status === 'expired' || status === 'error') return 'danger'; return ''; }
      function providerStatusText(status) { if (status === null || status === undefined || status === '') return '-'; var normalized = String(status).trim().toLowerCase().replace(/[\\s-]+/g, '_'); var text = statusText(normalized); if (text !== normalized) return text; var map = { new: '新建', created: '已创建', accepted: '已接收', submitted: '已提交', scheduled: '已调度', waiting: '等待中', wait: '等待中', pending_review: '等待审核', queue: '排队中', queued: '排队中', pending: '等待中', starting: '启动中', started: '已启动', init: '初始化中', initializing: '初始化中', in_progress: '进行中', processing: '处理中', process: '处理中', generating: '生成中', rendering: '渲染中', uploading: '上传中', storing: '存储中', delivering: '投递中', retry: '重试中', retrying: '重试中', done: '已完成', finished: '已完成', finish: '已完成', completed: '已完成', complete: '已完成', success: '成功', successful: '成功', failure: '失败', failed: '失败', error: '错误', errored: '错误', http_error: 'HTTP 错误', request_error: '请求错误', api_error: '接口错误', upstream_error: '上游错误', bad_request: '请求参数错误', invalid: '无效', unauthorized: '未授权', forbidden: '禁止访问', not_found: '未找到', rate_limited: '已限流', throttled: '已限流', internal_error: '内部错误', server_error: '服务端错误', service_unavailable: '服务不可用', rejected: '已拒绝', blocked: '已阻塞', denied: '已拒绝', cancelled: '已取消', canceled: '已取消', cancel: '已取消', canceling: '取消中', cancelling: '取消中', timeout: '超时', timed_out: '已超时', timeouted: '已超时', expired: '已过期', ok: '正常', warning: '警告', degraded: '降级' }; return map[normalized] || '未知状态：' + status; }
      function stageText(stage) { var map = { 'task.created': '任务创建', 'queue.enqueued': '已入队', 'queue.unavailable': '队列不可用', 'queue.enqueue_failed': '入队失败', 'queue.picked': '队列接收', 'process.started': '处理开始', 'process.failed': '处理失败', 'upstream.create.started': '上游创建开始', 'upstream.create.retry': '上游创建重试', 'upstream.create.succeeded': '上游创建成功', 'upstream.create.failed': '上游创建失败', 'upstream.poll.started': '轮询开始', 'upstream.poll.scheduled': '轮询已安排', 'upstream.poll.succeeded': '轮询成功', 'upstream.poll.failed': '轮询失败', 'poll.error': '轮询错误', 'task.succeeded': '任务成功', 'task.failed': '任务失败', 'task.canceled': '任务取消', 'task.expired': '任务过期', 'output.store.started': '输出存储开始', 'output.store.completed': '输出存储完成', 'callback.deliver_started': '回调投递开始', 'callback.delivered': '回调投递成功', 'callback.delivery_failed': '回调投递失败' }; return map[stage] || stage; }
      function formatDate(dateString) { if (!dateString) return '-'; var date = new Date(dateString); if (Number.isNaN(date.getTime())) return String(dateString); return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
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
