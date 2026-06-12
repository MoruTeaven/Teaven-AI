import { authenticateAdmin } from "../auth/admin";
import { loadGatewayConfig, validateGatewayConfig } from "../config";
import { invalidRequest, notFound } from "../http/errors";
import { jsonResponse } from "../http/response";
import { createProviderRegistry } from "../providers/registry";
import { getTask, listTasks } from "../tasks/store";
import type { AsyncTaskRecord, Env, GatewayConfig, ModelConfig } from "../types";
import { readJsonObject, requireString } from "../utils/request";

const RECENT_TASK_LIMIT = 25;

export async function handleAdminRequest(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string
): Promise<Response> {
  if (request.method === "GET" && pathname === "/admin") {
    return htmlResponse(ADMIN_HTML, {
      headers: {
        "X-Request-Id": requestId
      }
    });
  }

  if (!pathname.startsWith("/admin/api/")) {
    throw notFound("Endpoint not found");
  }

  authenticateAdmin(request, env);

  if (request.method === "GET" && pathname === "/admin/api/overview") {
    return handleAdminOverview(env, requestId);
  }

  if (request.method === "POST" && pathname === "/admin/api/config/validate") {
    return handleValidateConfig(request, requestId);
  }

  const taskMatch = pathname.match(/^\/admin\/api\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    return handleGetAdminTask(decodeURIComponent(taskMatch[1]), env, requestId);
  }

  throw notFound("Endpoint not found");
}

async function handleAdminOverview(env: Env, requestId: string): Promise<Response> {
  const config = loadGatewayConfig(env);
  const registry = createProviderRegistry(env);
  const recentTasks = await listTasks(env, RECENT_TASK_LIMIT);
  const routesTotal = config.models.reduce((count, model) => count + model.routes.length, 0);

  return jsonResponse(
    {
      status: "ok",
      gateway: {
        auth_mode: env.AUTH_MODE || "api_key",
        config_source: env.MODEL_CONFIG_JSON ? "MODEL_CONFIG_JSON" : "environment defaults",
        task_store: env.AI_GATEWAY_KV ? "kv" : "memory",
        db_bound: Boolean(env.DB),
        kv_bound: Boolean(env.AI_GATEWAY_KV),
        queue_bound: Boolean(env.TASK_QUEUE),
        r2_bound: Boolean(env.FILES)
      },
      stats: {
        models_total: config.models.length,
        models_active: config.models.filter((model) => model.status !== "disabled").length,
        routes_total: routesTotal,
        providers_total: registry.list().length,
        recent_tasks: recentTasks.length
      },
      warnings: buildWarnings(env),
      models: config.models.map(publicModel),
      providers: registry.list().map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        runtime: plugin.manifest.runtime,
        capabilities: plugin.manifest.capabilities,
        configured: isProviderConfigured(env, plugin.manifest.id)
      })),
      provider_config: {
        openai_compatible_base_url: env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
        openai_compatible_default_model: env.OPENAI_COMPATIBLE_DEFAULT_MODEL || "gpt-4o-mini",
        openai_compatible_api_key_configured: Boolean(env.OPENAI_COMPATIBLE_API_KEY)
      },
      recent_tasks: recentTasks.map(publicTaskSummary)
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
    throw notFound("Task not found");
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
        error: error instanceof Error ? error.message : "Invalid config"
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  }
}

function publicModel(model: ModelConfig): Record<string, unknown> {
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
      priority: route.priority ?? null,
      weight: route.weight ?? null,
      status: route.status || "active"
    }))
  };
}

function publicTaskSummary(task: AsyncTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    tenant_id: task.tenant_id,
    api_key_id: task.api_key_id,
    type: task.type,
    model: task.model,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    error: task.error
  };
}

function buildWarnings(env: Env): string[] {
  const warnings: string[] = [];

  if (!env.DEV_API_KEY && env.AUTH_MODE !== "none") {
    warnings.push("DEV_API_KEY is not configured; user API authentication will fail.");
  }
  if (!env.OPENAI_COMPATIBLE_API_KEY) {
    warnings.push("OPENAI_COMPATIBLE_API_KEY is not configured; chat completions will fail for the default provider.");
  }
  if (!env.AI_GATEWAY_KV) {
    warnings.push("AI_GATEWAY_KV is not bound; tasks are stored in memory and may disappear between isolates.");
  }
  if (!env.DB) {
    warnings.push("DB is not bound; tenant, API key, quota and billing management are not persistent yet.");
  }

  return warnings;
}

function isProviderConfigured(env: Env, pluginId: string): boolean {
  if (pluginId === "openai-compatible") {
    return Boolean(env.OPENAI_COMPATIBLE_API_KEY);
  }

  return false;
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

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Teaven AI Admin</title>
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
        <h1>Admin Dashboard</h1>
        <p class="subtitle">Operate the current Worker deployment: inspect models, provider wiring, storage bindings and async tasks.</p>
      </div>
      <div class="toolbar">
        <button id="refresh" class="secondary" type="button">Refresh</button>
      </div>
    </section>

    <section class="grid">
      <div class="card span-12">
        <h2>Admin Access</h2>
        <div class="login" style="margin-top: 14px;">
          <input id="token" type="password" autocomplete="off" placeholder="ADMIN_TOKEN">
          <button id="save-token" type="button">Connect</button>
          <button id="clear-token" class="secondary" type="button">Clear</button>
        </div>
        <div id="status" class="status">Enter ADMIN_TOKEN to load the dashboard.</div>
      </div>

      <div class="card span-12">
        <h2>Overview</h2>
        <div id="stats" class="stat-grid" style="margin-top: 14px;"></div>
        <div id="gateway-meta" class="meta"></div>
      </div>

      <div class="card span-12">
        <h2>Warnings</h2>
        <div id="warnings" class="warnings"></div>
      </div>

      <div class="card span-8">
        <h2>Models and Routes</h2>
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>Modality</th>
              <th>Status</th>
              <th>Stream</th>
              <th>Routes</th>
            </tr>
          </thead>
          <tbody id="models"></tbody>
        </table>
      </div>

      <div class="card span-4">
        <h2>Providers</h2>
        <div id="providers" style="margin-top: 14px;"></div>
      </div>

      <div class="card span-7">
        <h2>Recent Tasks</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Model</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="tasks"></tbody>
        </table>
      </div>

      <div class="card span-5">
        <h2>Task Lookup</h2>
        <div class="login" style="grid-template-columns: 1fr auto; margin-top: 14px;">
          <input id="task-id" type="text" placeholder="task_xxx">
          <button id="lookup-task" type="button">Lookup</button>
        </div>
        <pre id="task-output" class="json-view">No task loaded.</pre>
      </div>

      <div class="card span-12">
        <h2>MODEL_CONFIG_JSON Validator</h2>
        <p class="subtitle">Paste a GatewayConfig JSON object before deploying it as MODEL_CONFIG_JSON.</p>
        <textarea id="config-json" spellcheck="false" placeholder='{"models":[{"alias":"gpt-4o-mini","modality":"text","supports_stream":true,"status":"active","routes":[{"plugin_id":"openai-compatible","provider_model":"gpt-4o-mini","credential_id":"env:OPENAI_COMPATIBLE_API_KEY","priority":1,"weight":100,"status":"active"}]}]}'></textarea>
        <div class="toolbar" style="margin-top: 12px; justify-content: flex-start;">
          <button id="validate-config" type="button">Validate Config</button>
        </div>
        <pre id="config-output" class="json-view">No validation run.</pre>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var storageKey = 'teaven_admin_token';
      var tokenInput = document.getElementById('token');
      var statusEl = document.getElementById('status');
      var statsEl = document.getElementById('stats');
      var gatewayMetaEl = document.getElementById('gateway-meta');
      var warningsEl = document.getElementById('warnings');
      var modelsEl = document.getElementById('models');
      var providersEl = document.getElementById('providers');
      var tasksEl = document.getElementById('tasks');
      var taskOutputEl = document.getElementById('task-output');
      var configOutputEl = document.getElementById('config-output');

      tokenInput.value = localStorage.getItem(storageKey) || '';

      document.getElementById('save-token').addEventListener('click', loadOverview);
      document.getElementById('refresh').addEventListener('click', loadOverview);
      document.getElementById('clear-token').addEventListener('click', function () {
        localStorage.removeItem(storageKey);
        tokenInput.value = '';
        setStatus('Token cleared.', 'ok');
      });
      document.getElementById('lookup-task').addEventListener('click', lookupTask);
      document.getElementById('validate-config').addEventListener('click', validateConfig);

      if (tokenInput.value) {
        loadOverview();
      }

      async function api(path, options) {
        options = options || {};
        var token = tokenInput.value.trim();
        if (!token) {
          throw new Error('ADMIN_TOKEN is required.');
        }

        var headers = Object.assign({}, options.headers || {}, {
          Authorization: 'Bearer ' + token
        });
        if (options.body && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }

        var response = await fetch(path, Object.assign({}, options, { headers: headers }));
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          var message = data.error && data.error.message ? data.error.message : 'Request failed with HTTP ' + response.status;
          throw new Error(message);
        }
        return data;
      }

      async function loadOverview() {
        try {
          setStatus('Loading dashboard...', '');
          var data = await api('/admin/api/overview');
          localStorage.setItem(storageKey, tokenInput.value.trim());
          renderOverview(data);
          setStatus('Connected. Last refresh: ' + new Date().toLocaleString(), 'ok');
        } catch (error) {
          setStatus(error.message || String(error), 'error');
        }
      }

      async function lookupTask() {
        var taskId = document.getElementById('task-id').value.trim();
        if (!taskId) {
          taskOutputEl.textContent = 'Enter a task id first.';
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
        var configJson = document.getElementById('config-json').value;
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

      function renderOverview(data) {
        statsEl.innerHTML = renderStat('Models', data.stats.models_total) +
          renderStat('Active', data.stats.models_active) +
          renderStat('Routes', data.stats.routes_total) +
          renderStat('Providers', data.stats.providers_total) +
          renderStat('Tasks', data.stats.recent_tasks);

        gatewayMetaEl.innerHTML = renderMeta('Auth Mode', data.gateway.auth_mode) +
          renderMeta('Config Source', data.gateway.config_source) +
          renderMeta('Task Store', data.gateway.task_store) +
          renderMeta('Bindings', bindingsText(data.gateway));

        warningsEl.innerHTML = data.warnings.length
          ? data.warnings.map(function (warning) { return '<div class="warning">' + escapeHtml(warning) + '</div>'; }).join('')
          : '<span class="pill ok">No active warnings</span>';

        modelsEl.innerHTML = data.models.length
          ? data.models.map(renderModelRow).join('')
          : '<tr><td colspan="5" class="empty">No models configured.</td></tr>';

        providersEl.innerHTML = data.providers.length
          ? data.providers.map(renderProvider).join('')
          : '<p class="empty">No providers registered.</p>';

        tasksEl.innerHTML = data.recent_tasks.length
          ? data.recent_tasks.map(renderTaskRow).join('')
          : '<tr><td colspan="5" class="empty">No recent tasks.</td></tr>';
      }

      function renderStat(label, value) {
        return '<div class="stat"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>';
      }

      function renderMeta(label, value) {
        return '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
      }

      function renderModelRow(model) {
        var routes = model.routes.map(function (route) {
          return '<span class="pill">' + escapeHtml(route.plugin_id + ' / ' + route.provider_model) + '</span>' +
            '<span class="pill">priority ' + escapeHtml(route.priority === null ? 'n/a' : route.priority) + '</span>' +
            '<span class="pill ' + statusClass(route.status) + '">' + escapeHtml(route.status) + '</span>';
        }).join('<br>');

        return '<tr>' +
          '<td><code>' + escapeHtml(model.alias) + '</code></td>' +
          '<td>' + escapeHtml(model.modality) + '</td>' +
          '<td><span class="pill ' + statusClass(model.status) + '">' + escapeHtml(model.status) + '</span></td>' +
          '<td>' + (model.supports_stream ? 'yes' : 'no') + '</td>' +
          '<td>' + routes + '</td>' +
          '</tr>';
      }

      function renderProvider(provider) {
        var caps = Object.keys(provider.capabilities || {}).map(function (name) {
          var capability = provider.capabilities[name];
          return '<span class="pill">' + escapeHtml(name + ': ' + capability.execution_mode) + '</span>';
        }).join('');

        return '<div style="border: 1px solid var(--line); border-radius: 16px; padding: 14px; margin-bottom: 10px; background: #0b1220;">' +
          '<h3 style="font-size: 15px; margin-bottom: 8px;">' + escapeHtml(provider.name) + '</h3>' +
          '<div class="pill ' + (provider.configured ? 'ok' : 'danger') + '">' + (provider.configured ? 'configured' : 'missing credential') + '</div>' +
          '<div class="pill">' + escapeHtml(provider.id) + '</div>' +
          '<div class="pill">v' + escapeHtml(provider.version) + '</div>' +
          '<div style="margin-top: 8px;">' + caps + '</div>' +
          '</div>';
      }

      function renderTaskRow(task) {
        return '<tr>' +
          '<td><code>' + escapeHtml(task.id) + '</code></td>' +
          '<td>' + escapeHtml(task.type) + '</td>' +
          '<td>' + escapeHtml(task.model) + '</td>' +
          '<td><span class="pill ' + statusClass(task.status) + '">' + escapeHtml(task.status) + '</span></td>' +
          '<td>' + escapeHtml(task.created_at) + '</td>' +
          '</tr>';
      }

      function bindingsText(gateway) {
        return 'DB ' + yesNo(gateway.db_bound) + ', KV ' + yesNo(gateway.kv_bound) + ', Queue ' + yesNo(gateway.queue_bound) + ', R2 ' + yesNo(gateway.r2_bound);
      }

      function yesNo(value) {
        return value ? 'on' : 'off';
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
