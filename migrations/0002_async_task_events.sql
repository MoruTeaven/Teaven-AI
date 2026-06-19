-- 为异步任务增加状态链事件记录。
ALTER TABLE async_tasks ADD COLUMN events TEXT;
