-- Teaven AI Gateway - PostgreSQL Schema
-- 从 D1/SQLite migration 0001-0009 合并转换，用于自建 PG 部署。
-- 转换要点：
--   datetime('now')  -> to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')（保持 TEXT 时间戳，兼容代码层）
--   0003 RAISE(ABORT) trigger -> PL/pgSQL 函数 + trigger
--   CHECK / 部分唯一索引(WHERE IS NOT NULL) / 外键 / IF NOT EXISTS -> PG 原生兼容
--   REAL/INTEGER/TEXT -> PG 类型别名，保持原名减少改动

-- ============================================================
-- organizations
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  updated_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);

-- ============================================================
-- users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email           TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  nickname        TEXT NOT NULL DEFAULT '',   -- 0007
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  updated_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);  -- 0003

-- ============================================================
-- api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL DEFAULT '',
  key_hash           TEXT NOT NULL,
  key_prefix         TEXT NOT NULL DEFAULT '',
  allowed_models     TEXT,
  allowed_modalities TEXT,   -- 0009
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','expired')),
  expires_at         TEXT,
  last_used_at       TEXT,
  encrypted_key      TEXT,   -- 0003
  encrypted_key_iv   TEXT,   -- 0003
  created_at         TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  updated_at         TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_organization ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_unique ON api_keys(key_hash);  -- 0003
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);  -- 0003

-- ============================================================
-- gateway_configs (KV 的 D1 持久化备选)
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway_configs (
  key         TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);

-- ============================================================
-- site_settings  0004
-- ============================================================
CREATE TABLE IF NOT EXISTS site_settings (
  key           TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);

-- ============================================================
-- usage_records
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_records (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL,
  organization_id   TEXT NOT NULL,
  api_key_id        TEXT NOT NULL,
  endpoint          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL DEFAULT '',
  requested_model   TEXT,   -- 0005
  upstream_id       TEXT,
  plugin_id         TEXT,
  provider_model    TEXT,
  credential_ref    TEXT,   -- 0006
  status_code       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  stream            INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  media_count       INTEGER NOT NULL DEFAULT 0,
  cost              REAL    NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_usage_organization ON usage_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_records(api_key_id);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_requested_model ON usage_records(requested_model);  -- 0005
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request_unique ON usage_records(request_id);  -- 0003
CREATE INDEX IF NOT EXISTS idx_usage_credential_ref ON usage_records(credential_ref);  -- 0006

-- ============================================================
-- async_tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS async_tasks (
  id                      TEXT PRIMARY KEY,
  organization_id         TEXT NOT NULL,
  api_key_id              TEXT NOT NULL,
  type                    TEXT NOT NULL DEFAULT '',
  model                   TEXT NOT NULL DEFAULT '',
  requested_model         TEXT,   -- 0005
  upstream_id             TEXT,
  plugin_id               TEXT,
  provider_execution_mode TEXT,
  provider_task_id        TEXT,
  provider_context        TEXT,
  credential_ref          TEXT,   -- 0006
  status                  TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled','expired')),
  input                   TEXT NOT NULL DEFAULT '{}',
  output                  TEXT,
  events                  TEXT,   -- 0002
  store_output            INTEGER NOT NULL DEFAULT 0,
  storage_ttl_seconds     INTEGER NOT NULL DEFAULT 0,
  output_expires_at       TEXT,
  callback_url            TEXT,
  metadata                TEXT,
  error                   TEXT,
  idempotency_key         TEXT,
  lease_owner             TEXT,   -- 0008
  lease_expires_at        TEXT,   -- 0008
  next_poll_at            TEXT,
  created_at              TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  updated_at              TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  completed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_organization ON async_tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON async_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON async_tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON async_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_org_created ON async_tasks(organization_id, created_at DESC);  -- 0008
CREATE INDEX IF NOT EXISTS idx_tasks_status_next_poll ON async_tasks(status, next_poll_at);  -- 0008
CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires ON async_tasks(lease_expires_at);  -- 0008
CREATE INDEX IF NOT EXISTS idx_tasks_credential_ref ON async_tasks(credential_ref);  -- 0006
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_org_idempotency_unique
  ON async_tasks(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;  -- 0003
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_upstream_provider_task_unique
  ON async_tasks(upstream_id, provider_task_id)
  WHERE upstream_id IS NOT NULL AND provider_task_id IS NOT NULL;  -- 0003

-- 0003 状态机 trigger（SQLite RAISE(ABORT) -> PL/pgSQL）
CREATE OR REPLACE FUNCTION check_async_task_status_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'queued' AND NEW.status IN ('running','failed','canceled','expired'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded','failed','canceled','expired'))
  ) THEN
    RAISE EXCEPTION 'invalid async task status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_async_tasks_status_transition
BEFORE UPDATE OF status ON async_tasks
FOR EACH ROW
EXECUTE FUNCTION check_async_task_status_transition();

-- ============================================================
-- credential_usage_counters  0006
-- ============================================================
CREATE TABLE IF NOT EXISTS credential_usage_counters (
  credential_ref TEXT NOT NULL,
  window_type    TEXT NOT NULL,
  window_key     TEXT NOT NULL,
  requests       INTEGER NOT NULL DEFAULT 0,
  tokens         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')),
  PRIMARY KEY (credential_ref, window_type, window_key)
);

-- ============================================================
-- model_speed_stats  0008
-- ============================================================
CREATE TABLE IF NOT EXISTS model_speed_stats (
  model                     TEXT PRIMARY KEY,
  sample_count              INTEGER NOT NULL DEFAULT 0,
  total_completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_latency_ms          INTEGER NOT NULL DEFAULT 0,
  average_tokens_per_second REAL    NOT NULL DEFAULT 0,
  updated_at                TEXT    NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_model_speed_updated ON model_speed_stats(updated_at);

-- ============================================================
-- kv_store — KV 兼容层（迁移自 Workers KV）
-- ============================================================
CREATE TABLE IF NOT EXISTS kv_store (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_store(expires_at);
