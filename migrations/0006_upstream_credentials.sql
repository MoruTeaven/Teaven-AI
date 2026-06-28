-- 多凭证与凭证配额支持
--
-- 背景：一个上游可配置多个凭证（key），按权重加权随机挑选，
-- 每个凭证可独立设置按小时/天/周/月的配额上限。
-- credential_ref 是凭证的稳定跟踪 ID（非密钥本身），用于用量记录与异步任务排错。

-- ============================================================
-- 凭证用量计数器 — 用于配额预检（O(1) 读写当前窗口）
-- ============================================================
-- credential_ref:  形如 "{upstream_id}:{credential.id}"，跨上游唯一
-- window_type:     'hour' | 'day' | 'week' | 'month'
-- window_key:      窗口桶 key，例如 '2026-06-28T14' / '2026-06-28' / '2026-W26' / '2026-06'
CREATE TABLE IF NOT EXISTS credential_usage_counters (
  credential_ref TEXT NOT NULL,
  window_type    TEXT NOT NULL,
  window_key     TEXT NOT NULL,
  requests       INTEGER NOT NULL DEFAULT 0,
  tokens         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (credential_ref, window_type, window_key)
);

-- ============================================================
-- usage_records 增加 credential_ref 列
-- 记录本次调用实际使用的凭证跟踪 ID，便于按 key 维度排错与统计。
-- ============================================================
ALTER TABLE usage_records ADD COLUMN credential_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_credential_ref ON usage_records(credential_ref);

-- ============================================================
-- async_tasks 增加 credential_ref 列
-- 与 provider_context.credential_ref 一致，提升为顶层列便于查询。
-- ============================================================
ALTER TABLE async_tasks ADD COLUMN credential_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_credential_ref ON async_tasks(credential_ref);
