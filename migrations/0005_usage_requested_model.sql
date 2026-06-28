-- 为 usage_records 增加 requested_model 列。
-- 记录用户请求里原始的 model 字段（可能是模型分组别名，如 tier:advanced），
-- 便于通过 request_id 反查实际命中的模型（model 列）与用户原始请求。
ALTER TABLE usage_records ADD COLUMN requested_model TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_requested_model ON usage_records(requested_model);

-- 为 async_tasks 增加 requested_model 列。
-- 异步任务对外展示 model = requested_model（组别名），
-- 内部 model 列保留实际命中的模型别名，便于 consumer 处理与排查。
ALTER TABLE async_tasks ADD COLUMN requested_model TEXT;
