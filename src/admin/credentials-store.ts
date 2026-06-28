/**
 * 凭证配额存储与预检。
 *
 * 计数策略：固定窗口（fixed window）。
 * - hour:  整点重置（桶 key = YYYY-MM-DDTHH）
 * - day:   自然日重置（桶 key = YYYY-MM-DD）
 * - week:  ISO 周重置（桶 key = YYYY-WNN）
 * - month: 自然月重置（桶 key = YYYY-MM）
 *
 * 持久化：优先 D1（credential_usage_counters 表）。
 * 未绑定 D1 时退回内存 Map（仅限当前 isolate，跨 isolate 不共享，仅适合开发）。
 *
 * 配额预检在调用上游前进行；用量累加在调用完成（拿到 tokens）后进行。
 * tokens 为尽力而为：调用前用当前已用量与 max_tokens 比较，调用后再补记本次 tokens。
 */
import type { CredentialLimit, CredentialLimitWindow, Env } from "../types";

const MEMORY_COUNTERS = new Map<string, { requests: number; tokens: number }>();

interface CounterRow {
  requests: number;
  tokens: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  /** 命中的第一个超限窗口，便于排错 */
  exceeded?: { limit: CredentialLimit; current_requests: number; current_tokens: number };
}

/**
 * 预检某凭证是否仍在配额内。
 * 任一已配置窗口超限即视为不可用。
 */
export async function checkCredentialQuota(
  env: Env,
  credentialRef: string,
  limits: CredentialLimit[] | undefined
): Promise<QuotaCheckResult> {
  if (!limits || limits.length === 0) {
    return { allowed: true };
  }

  const now = new Date();
  for (const limit of limits) {
    const windowKey = windowKeyFor(now, limit.window);
    const counter = await readCounter(env, credentialRef, limit.window, windowKey);
    if (limit.max_requests !== undefined && counter.requests >= limit.max_requests) {
      return {
        allowed: false,
        exceeded: {
          limit,
          current_requests: counter.requests,
          current_tokens: counter.tokens
        }
      };
    }
    if (limit.max_tokens !== undefined && counter.tokens >= limit.max_tokens) {
      return {
        allowed: false,
        exceeded: {
          limit,
          current_requests: counter.requests,
          current_tokens: counter.tokens
        }
      };
    }
  }

  return { allowed: true };
}

/**
 * 累加某凭证的用量计数。只对凭证配置中存在的窗口类型写计数器。
 */
export async function recordCredentialUsage(
  env: Env,
  credentialRef: string,
  limits: CredentialLimit[] | undefined,
  tokens: number
): Promise<void> {
  if (!limits || limits.length === 0) {
    return;
  }

  const now = new Date();
  const seenWindows = new Set<CredentialLimitWindow>();
  for (const limit of limits) {
    if (seenWindows.has(limit.window)) {
      continue;
    }
    seenWindows.add(limit.window);
    const windowKey = windowKeyFor(now, limit.window);
    await incrementCounter(env, credentialRef, limit.window, windowKey, 1, tokens);
  }
}

async function readCounter(
  env: Env,
  credentialRef: string,
  windowType: CredentialLimitWindow,
  windowKey: string
): Promise<CounterRow> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT requests, tokens FROM credential_usage_counters WHERE credential_ref = ? AND window_type = ? AND window_key = ?"
      ).bind(credentialRef, windowType, windowKey).first<{ requests: number; tokens: number }>();
      if (row) {
        return {
          requests: typeof row.requests === "number" ? row.requests : Number(row.requests || 0),
          tokens: typeof row.tokens === "number" ? row.tokens : Number(row.tokens || 0)
        };
      }
      return { requests: 0, tokens: 0 };
    } catch (error) {
      if (!isMissingD1TableError(error, "credential_usage_counters")) {
        throw error;
      }
    }
  }

  const memoryKey = memoryKeyFor(credentialRef, windowType, windowKey);
  const entry = MEMORY_COUNTERS.get(memoryKey);
  return entry ? { ...entry } : { requests: 0, tokens: 0 };
}

async function incrementCounter(
  env: Env,
  credentialRef: string,
  windowType: CredentialLimitWindow,
  windowKey: string,
  requestDelta: number,
  tokenDelta: number
): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO credential_usage_counters (credential_ref, window_type, window_key, requests, tokens, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(credential_ref, window_type, window_key) DO UPDATE SET
          requests = credential_usage_counters.requests + excluded.requests,
          tokens = credential_usage_counters.tokens + excluded.tokens,
          updated_at = excluded.updated_at
      `).bind(credentialRef, windowType, windowKey, requestDelta, tokenDelta, new Date().toISOString()).run();
      return;
    } catch (error) {
      if (!isMissingD1TableError(error, "credential_usage_counters")) {
        throw error;
      }
    }
  }

  const memoryKey = memoryKeyFor(credentialRef, windowType, windowKey);
  const entry = MEMORY_COUNTERS.get(memoryKey) || { requests: 0, tokens: 0 };
  entry.requests += requestDelta;
  entry.tokens += tokenDelta;
  MEMORY_COUNTERS.set(memoryKey, entry);
}

/**
 * 计算固定窗口的桶 key。
 * - hour:  本地时间无关，使用 UTC 整点，格式 YYYY-MM-DDTHH
 * - day:   UTC 日期 YYYY-MM-DD
 * - week:  ISO 周 YYYY-WNN（周一为一周起点）
 * - month: UTC 月份 YYYY-MM
 */
export function windowKeyFor(date: Date, window: CredentialLimitWindow): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();

  switch (window) {
    case "hour":
      return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hours)}`;
    case "day":
      return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
    case "week":
      return `${pad4(year)}-W${pad2(isoWeekNumber(date))}`;
    case "month":
      return `${pad4(year)}-${pad2(month)}`;
  }
}

/** ISO 周编号（周一为一周起点）。返回 1~53。 */
function isoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = target.getUTCDay() || 7; // 周日 → 7
  target.setUTCDate(target.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.round(((target.getTime() - yearStart.getTime()) / 86400000) / 7) + 1;
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function memoryKeyFor(credentialRef: string, windowType: string, windowKey: string): string {
  return `${credentialRef}|${windowType}|${windowKey}`;
}

function isMissingD1TableError(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes(`no such table: ${table.toLowerCase()}`);
}
