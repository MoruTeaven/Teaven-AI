import { createD1Pg } from "../adapters/d1-pg";
import { createKvPg } from "../adapters/kv-pg";
import { createTaskQueue } from "../adapters/task-queue";
import type { SqlExecutor } from "../adapters/sql";
import type { Env } from "../types";

/**
 * 两种运行时共用的 Env 组装。
 *
 * 业务代码（src/index.ts 及全部路由）只认 Workers 风格的 `env.DB` /
 * `env.AI_GATEWAY_KV` / `env.TASK_QUEUE` / `env.FILES`。不同运行时的差别只是
 * 「这些东西从哪来」：
 *
 * | 运行时 | 入口 | executor 来自 | files 来自 |
 * | --- | --- | --- | --- |
 * | Node 自建（当前生产） | src/server/node-entry.ts | node-postgres Pool | r2-s3.ts（@aws-sdk/client-s3） |
 * | celld / Workers（迁移目标） | src/server/celld-entry.ts | postgres.js | celld 原生 R2 绑定 |
 *
 * 业务代码与全部适配层对两者无感知。
 */
export interface EnvSource {
  /** PG 执行器：node-postgres Pool 或 postgres.js 都先包成 SqlExecutor。 */
  executor: SqlExecutor;
  /** 已具备 Workers R2 接口形状（get/put）的对象。 */
  files: unknown;
  /** 标量配置（token / 上游凭证 / 模型配置等）。 */
  vars: Record<string, string | undefined>;
}

/** Env 上全部标量字段。显式列举而非透传整个 env，避免意外泄漏绑定。 */
const SCALAR_VARS = [
  "AUTH_MODE",
  "ADMIN_TOKEN",
  "USER_CENTER_TOKEN",
  "DEV_API_KEY",
  "MODEL_CONFIG_JSON",
  "PROVIDER_SECRET_ALLOWLIST",
  "ALLOW_INLINE_PROVIDER_CREDENTIALS",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_DEFAULT_MODEL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "FILES_PUBLIC_BASE_URL",
  "API_ORIGIN",
] as const;

export function buildEnv({ executor, files, vars }: EnvSource): Env {
  const env: Record<string, unknown> = {
    DB: createD1Pg(executor),
    AI_GATEWAY_KV: createKvPg(executor),
    FILES: files,
  };
  for (const key of SCALAR_VARS) {
    const value = vars[key];
    if (value !== undefined) env[key] = value;
  }
  // TASK_QUEUE 需要 env 自身，排在最后
  env.TASK_QUEUE = createTaskQueue(env as Env, executor);
  return env as Env;
}
