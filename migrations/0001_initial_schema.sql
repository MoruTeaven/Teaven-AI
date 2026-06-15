-- Teaven AI Gateway - 初始数据库 Schema
-- 对应今天的字段清理：已移除 protocol_type 和 provider 冗余字段

-- ============================================================
-- 租户
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 用户
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- ============================================================
-- API Key
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL DEFAULT '',
  key_hash        TEXT NOT NULL,
  key_prefix      TEXT NOT NULL DEFAULT '',
  allowed_models  TEXT,                          -- JSON array of model aliases
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired')),
  expires_at      TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant  ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user    ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash    ON api_keys(key_hash);

-- ============================================================
-- 网关配置 — 对应 GatewayConfig，作为 KV JSON 的 D1 持久化备选
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway_configs (
  key           TEXT PRIMARY KEY,                -- 配置键，固定为 'default'
  config_json   TEXT NOT NULL,                   -- 完整的 GatewayConfig JSON
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 使用量记录 — 对应 UsageRecord
-- 注意：已移除 provider 冗余字段
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_records (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  api_key_id        TEXT NOT NULL,
  endpoint          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  upstream_id       TEXT,
  plugin_id         TEXT,                        -- 替代 protocol_type，插件即协议
  provider_model    TEXT,
  status_code       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  stream            INTEGER NOT NULL DEFAULT 0,  -- boolean 0/1
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  media_count       INTEGER NOT NULL DEFAULT 0,
  cost              REAL    NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant     ON usage_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_key        ON usage_records(api_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_model      ON usage_records(model);
CREATE INDEX IF NOT EXISTS idx_usage_created    ON usage_records(created_at);

-- ============================================================
-- 异步任务 — 对应 AsyncTaskRecord
-- 注意：已移除 provider 冗余字段
-- ============================================================
CREATE TABLE IF NOT EXISTS async_tasks (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  api_key_id              TEXT NOT NULL,
  type                    TEXT NOT NULL DEFAULT '',
  model                   TEXT NOT NULL DEFAULT '',
  upstream_id             TEXT,
  plugin_id               TEXT,
  provider_execution_mode TEXT,                  -- sync / async_polling / async_webhook
  provider_task_id        TEXT,
  provider_context        TEXT,                  -- JSON object
  status                  TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'expired')),
  input                   TEXT NOT NULL DEFAULT '{}',  -- JSON object
  output                  TEXT,                          -- JSON array
  store_output            INTEGER NOT NULL DEFAULT 0,
  storage_ttl_seconds     INTEGER NOT NULL DEFAULT 0,
  output_expires_at       TEXT,
  callback_url            TEXT,
  metadata                TEXT,                  -- JSON object
  error                   TEXT,                  -- JSON or string
  idempotency_key         TEXT,
  next_poll_at            TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant      ON async_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON async_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON async_tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tasks_created     ON async_tasks(created_at);
