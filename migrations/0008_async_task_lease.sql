-- 为异步任务增加处理租约与更适合多租户分页/补偿的索引。
ALTER TABLE async_tasks ADD COLUMN lease_owner TEXT;
ALTER TABLE async_tasks ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_org_created
  ON async_tasks(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_status_next_poll
  ON async_tasks(status, next_poll_at);

CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires
  ON async_tasks(lease_expires_at);
