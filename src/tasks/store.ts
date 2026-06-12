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

export async function listTasks(env: Env, limit = 25): Promise<AsyncTaskRecord[]> {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 25;
  const boundedLimit = Math.min(Math.max(requestedLimit, 1), 100);
  const kv = env.AI_GATEWAY_KV;

  if (kv) {
    const listed = await kv.list({ prefix: "task:", limit: boundedLimit });
    const tasks = await Promise.all(listed.keys.map((key) => kv.get(key.name, "json")));
    return tasks.filter(isTaskRecord).sort(compareTasksByCreatedAt).slice(0, boundedLimit);
  }

  return [...MEMORY_TASKS.values()].sort(compareTasksByCreatedAt).slice(0, boundedLimit);
}

function taskKey(taskId: string): string {
  return `task:${taskId}`;
}

function isTaskRecord(value: unknown): value is AsyncTaskRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<AsyncTaskRecord>;
  return task.object === "task" && typeof task.id === "string";
}

function compareTasksByCreatedAt(left: AsyncTaskRecord, right: AsyncTaskRecord): number {
  return right.created_at.localeCompare(left.created_at);
}
