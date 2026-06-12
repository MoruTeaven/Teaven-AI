import type { AsyncTaskRecord, Env } from "../types";

const MEMORY_TASKS = new Map<string, AsyncTaskRecord>();
const TASK_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function saveTask(env: Env, task: AsyncTaskRecord): Promise<void> {
  MEMORY_TASKS.set(task.id, task);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(taskKey(task.id), JSON.stringify(task), {
      expirationTtl: TASK_KV_TTL_SECONDS
    });
  }
}

export async function getTask(env: Env, taskId: string): Promise<AsyncTaskRecord | undefined> {
  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(taskKey(taskId), "json");
    if (stored && typeof stored === "object") {
      return stored as AsyncTaskRecord;
    }
  }

  return MEMORY_TASKS.get(taskId);
}

function taskKey(taskId: string): string {
  return `task:${taskId}`;
}
