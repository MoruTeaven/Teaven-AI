-- 将运行时核心数据约束收敛到 D1。

-- API Key 明文只展示一次，但密文需要持久化以支持受控查看。
ALTER TABLE api_keys ADD COLUMN encrypted_key TEXT;
ALTER TABLE api_keys ADD COLUMN encrypted_key_iv TEXT;

-- 用户登录按邮箱查找，邮箱必须全局唯一。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);

-- API Key token 哈希必须唯一，避免同一 token 映射到多个身份。
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_unique ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- usage 按请求去重，防止重试路径重复累计。
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request_unique ON usage_records(request_id);

-- 同一组织内的幂等键只能对应一个任务；NULL 不参与唯一约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_org_idempotency_unique
  ON async_tasks(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 上游任务 ID 在同一 upstream 内唯一；NULL 不参与唯一约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_upstream_provider_task_unique
  ON async_tasks(upstream_id, provider_task_id)
  WHERE upstream_id IS NOT NULL AND provider_task_id IS NOT NULL;

-- D1 层强制状态机，防止并发处理把终态任务写回非终态。
CREATE TRIGGER IF NOT EXISTS trg_async_tasks_status_transition
BEFORE UPDATE OF status ON async_tasks
FOR EACH ROW
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'canceled', 'expired'))
  OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'canceled', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid async task status transition');
END;
