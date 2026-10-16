import type { SqlExecutor } from "./sql";

/**
 * KV 兼容层：Workers KV 的 get/put/delete/list 适配到 PG kv_store 表。
 * - get(key,"json") 自动 JSON.parse
 * - put 支持 expirationTtl（写入 expires_at，读取时按需过滤）
 * 业务代码已有 if(env.AI_GATEWAY_KV) 回退分支，注入后无需改动。
 * 建表见 migrations_pg/schema.sql 的 kv_store。
 *
 * 只依赖 SqlExecutor，不关心底层是 node-postgres 还是 postgres.js。
 */
export function createKvPg(pool: SqlExecutor) {
  return {
    async get<T = unknown>(key: string, options?: { type?: "json" | "text" }): Promise<T | null> {
      const r = await pool.query(
        "SELECT value FROM kv_store WHERE key = $1 AND (expires_at IS NULL OR expires_at > now()::text)",
        [key]
      );
      if (!r.rows[0]) return null;
      const raw = r.rows[0].value as string;
      if (options?.type === "json") {
        try { return JSON.parse(raw) as T; } catch { return null; }
      }
      return raw as unknown as T;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expires = options?.expirationTtl
        ? new Date(Date.now() + options.expirationTtl * 1000).toISOString()
        : null;
      await pool.query(
        `INSERT INTO kv_store (key, value, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
        [key, value, expires]
      );
    },
    async delete(key: string): Promise<void> {
      await pool.query("DELETE FROM kv_store WHERE key = $1", [key]);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const r = await pool.query(
        "SELECT key AS name FROM kv_store WHERE key LIKE $1 ORDER BY key LIMIT $2",
        [prefix + "%", limit]
      );
      return { keys: r.rows as { name: string }[] };
    },
  };
}
