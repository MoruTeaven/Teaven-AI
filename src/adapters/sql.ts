/**
 * PG 执行器抽象。
 *
 * 为什么需要它：项目要跑在两种运行时上，PG 驱动不通用。
 * - Node 自建形态：node-postgres（`pg`），依赖 `node:net` / `node:tls`。
 * - celld / Workers 形态：**必须换 postgres.js**。celld 的 Node 兼容是 Partial，
 *   只实现 assert/async_hooks/buffer/diagnostics_channel/events/fs/os/path/
 *   stream/timers/promises/util，**没有 node:net 和 node:tls**；`pg` 在 celld 下
 *   import 虽成功但首次调用必抛。postgres.js 的包 exports 里带
 *   `"workerd": "./cf/src/index.js"` 条件导出，该构建用 polyfill 把
 *   net.Socket / tls.connect 换成 Workers 原生 TCP socket。
 *
 * 收益：d1-pg / kv-pg / task-queue 只依赖这个最小接口，换驱动时它们一行不用改。
 */

export interface QueryResultLike<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<T = any>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
}

/** node-postgres 适配（Node 自建形态）。 */
export function createPgExecutor(pool: {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}): SqlExecutor {
  return {
    query: (text, values) => pool.query(text, values),
  };
}

/**
 * postgres.js 适配（celld / Workers 形态）。
 *
 * `sql.unsafe(text, args)` 的签名与 pg 的 `query(text, values)` 对齐：
 * 同样接收 `$n` 占位符与参数数组，同样以行数组表达结果（pg 包一层 `{ rows }`）。
 */
export function createPostgresExecutor(sql: {
  unsafe(text: string, args?: unknown[]): Promise<any[]>;
}): SqlExecutor {
  return {
    async query<T = any>(text: string, values: unknown[] = []) {
      const rows = await sql.unsafe(text, values);
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
}
