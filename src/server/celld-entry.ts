import postgres from "postgres";
import gateway from "../index";
import { createPostgresExecutor } from "../adapters/sql";
import { pollTaskQueue } from "../adapters/task-queue";
import { buildEnv } from "./env-factory";
import type { Env } from "../types";
import type { AsyncTaskQueueMessage } from "../types";

/**
 * celld / Workers 形态入口（**迁移目标形态**）。
 *
 * 与 node-entry.ts 的唯一差别是「东西从哪来」，业务逻辑（src/index.ts 及全部
 * 路由）完全共用：
 * - PG：postgres.js（**不是 node-postgres**）。celld 的 Node 兼容是 Partial，
 *   未实现 node:net / node:tls，而 `pg` 靠这两个模块建连接。postgres.js 的包
 *   exports 带 `"workerd": "./cf/src/index.js"` 条件导出，该构建用 polyfill 把
 *   net.Socket / tls.connect 换成 Workers 原生 TCP socket。import 时写裸包名，
 *   打包器按 conditions 自动选中 workerd 构建。
 * - FILES：直接用 celld 原生 R2 绑定（wrangler.json 的 r2_buckets）。
 *
 * ⚠️ 两处上线前必须确认：
 * 1. FILES 换成原生 R2 绑定后，**业务文件会落到 celld 的对象存储**，而不是当前的
 *    Cloudflare R2。存量文件如何迁移、是否接受这个存储归属变更，需先定案。
 * 2. PG 口令必须走 celld secret，绝不能写进 wrangler.json（PoC 阶段曾明文写过）。
 *
 * ⚠️ 定时轮询：Worker isolate 随时可能被回收，setInterval 不保证存活。
 *    因此不靠常驻定时器，改由 `scheduled` handler 驱动（配 wrangler.json 的
 *    triggers.crons），每次触发扫一轮到期任务。
 */

type Bindings = Record<string, unknown> & {
  /** celld 原生 R2 绑定。 */
  FILES?: unknown;
  PG_HOST?: string;
  PG_PORT?: string;
  PG_DATABASE?: string;
  PG_USER?: string;
  PG_PASSWORD?: string;
};

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

/** 每 isolate 一份：连接池与适配器都要复用，不能每次请求重建。 */
let cachedSql: ReturnType<typeof postgres> | null = null;
let cachedEnv: Env | null = null;

function getSql(bindings: Bindings) {
  if (cachedSql) return cachedSql;
  cachedSql = postgres({
    host: bindings.PG_HOST ?? "127.0.0.1",
    port: Number(bindings.PG_PORT ?? 5432),
    database: bindings.PG_DATABASE ?? "postgres",
    user: bindings.PG_USER ?? "postgres",
    password: bindings.PG_PASSWORD ?? "",
    // celld 里默认 max=3；这里与 Node 形态对齐到 10，内存吃紧时调小
    max: Number(bindings.PG_POOL_MAX ?? 10),
  });
  return cachedSql;
}

function getEnv(bindings: Bindings): Env {
  if (cachedEnv) return cachedEnv;

  if (!bindings.FILES) {
    throw new Error("缺少 FILES 绑定：请在 wrangler.json 的 r2_buckets 中声明");
  }

  const vars: Record<string, string | undefined> = {};
  for (const key of SCALAR_VARS) {
    const value = bindings[key];
    if (typeof value === "string") vars[key] = value;
  }

  cachedEnv = buildEnv({
    executor: createPostgresExecutor(getSql(bindings)),
    files: bindings.FILES,
    vars,
  });
  return cachedEnv;
}

export default {
  async fetch(request: Request, bindings: Bindings): Promise<Response> {
    return gateway.fetch(request, getEnv(bindings));
  },

  async queue(batch: MessageBatch<AsyncTaskQueueMessage>, bindings: Bindings): Promise<void> {
    return gateway.queue(batch, getEnv(bindings));
  },

  /**
   * 定时扫一轮到期任务。轮询间隔见 wrangler.json 的 triggers.crons
   * （对应 Node 形态的 POLL_INTERVAL_MS = 5000，取整到 1 分钟）。
   */
  async scheduled(_event: unknown, bindings: Bindings): Promise<void> {
    // CF Worker 形态没有 PG 绑定，同一份配置被 CF 侧触发时静默跳过
    if (!bindings.PG_HOST) return;
    await pollTaskQueue(getEnv(bindings), createPostgresExecutor(getSql(bindings)));
  },
};
