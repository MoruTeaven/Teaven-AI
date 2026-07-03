-- 模型平均速度统计。
--
-- 速度定义：成功聊天补全的 completion_tokens / 完整请求耗时，单位 tokens/s。
-- 调用开始前读取上一轮已统计均速并返回给本次响应；调用完成后写入本次样本，供下一次调用使用。

CREATE TABLE IF NOT EXISTS model_speed_stats (
  model                     TEXT PRIMARY KEY,
  sample_count              INTEGER NOT NULL DEFAULT 0,
  total_completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_latency_ms          INTEGER NOT NULL DEFAULT 0,
  average_tokens_per_second REAL    NOT NULL DEFAULT 0,
  updated_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_speed_updated ON model_speed_stats(updated_at);
