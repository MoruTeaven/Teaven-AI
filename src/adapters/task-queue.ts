import { Pool } from "pg";
import { processTask } from "../tasks/processor";
import { createId } from "../utils/ids";
import type { Env, AsyncTaskQueueMessage } from "../types";

/**
 * Queue 兼容层：Workers Queue 的 send 适配到内存调度 + DB 兜底轮询。
 * - send({task_id}, {delaySeconds}) → setTimeout 延迟调 processTask
 * - setInterval 扫 async_tasks 找 next_poll_at 到期/queued 且 lease 过期的任务
 * - processTask 内部 claimTask（lease 互斥），并发调度安全
 */
const POLL_INTERVAL_MS = 5000;
const POLL_BATCH = 20;

export function createTaskQueue(env: Env, pool: Pool) {
  const owner = createId("poller");
  void owner;
  const queue = {
    send(message: AsyncTaskQueueMessage, options?: { delaySeconds?: number }) {
      const delay = options?.delaySeconds ?? 0;
      const run = () => {
        processTask(env, message.task_id).catch((err) =>
          console.error(`[queue] processTask ${message.task_id} failed:`, err)
        );
      };
      if (delay > 0) setTimeout(run, delay * 1000);
      else setImmediate(run);
    },
  };
  const timer = setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const r = await pool.query(
        `SELECT id FROM async_tasks
         WHERE status IN ('queued','running')
           AND (next_poll_at IS NULL OR next_poll_at <= $1)
           AND (lease_expires_at IS NULL OR lease_expires_at < $1)
         LIMIT $2`,
        [now, POLL_BATCH]
      );
      for (const row of r.rows) {
        processTask(env, row.id as string).catch(() => {});
      }
    } catch (err) {
      console.error("[poller] scan failed:", err);
    }
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  return queue;
}
