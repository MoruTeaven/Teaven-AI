import { Pool } from "pg";

/**
 * D1 兼容层：把 Workers D1 的 prepare().bind().first()/all()/run() 适配到 node-postgres。
 * - SQLite ? 占位符自动转 PG $n
 * - ON CONFLICT ... DO UPDATE SET x = excluded.x（PG 原生支持，无需转换）
 * - first() → 取首行；all() → { results }；run() → { meta: { changes: rowCount } }
 * 业务代码已用 if(env.DB) 守卫，注入此对象后无需改动。
 */
export function createD1Pg(pool: Pool) {
  return {
    prepare(sql: string) {
      const text = toPgPlaceholders(sql);
      let bindings: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { bindings = values; return stmt; },
        async first<T>(): Promise<T | null> {
          const r = await pool.query(text, bindings);
          return (r.rows[0] as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const r = await pool.query(text, bindings);
          return { results: r.rows as T[] };
        },
        async run<T = unknown>(): Promise<{ results: T[]; meta: { changes: number } }> {
          const r = await pool.query(text, bindings);
          return { results: [] as T[], meta: { changes: r.rowCount ?? 0 } };
        },
      };
      return stmt;
    },
  };
}

function toPgPlaceholders(sql: string): string {
  let n = 0;
  let s = sql.replace(/\?/g, () => `$${++n}`);
  // SQLite 方言 INSERT OR IGNORE → PG ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    s = s.replace(/;\s*$/, '').trimEnd() + ' ON CONFLICT DO NOTHING';
  }
  return s;
}
