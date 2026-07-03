import type { Env } from "../types";

const MODEL_SPEED_PREFIX = "admin:model_speed:";
const MEMORY_MODEL_SPEED = new Map<string, ModelSpeedStats>();

type D1Row = Record<string, unknown>;

export interface ModelSpeedStats {
  model: string;
  sample_count: number;
  total_completion_tokens: number;
  total_latency_ms: number;
  average_tokens_per_second: number;
  updated_at: string;
}

export interface ModelSpeedSnapshot {
  model: string;
  unit: "tokens_per_second";
  average_tokens_per_second: number;
  sample_count: number;
  updated_at: string;
}

export async function getModelSpeedSnapshot(env: Env, model: string): Promise<ModelSpeedSnapshot | null> {
  const stats = await getModelSpeedStats(env, model);
  if (!stats || stats.sample_count <= 0 || stats.average_tokens_per_second <= 0) {
    return null;
  }

  return {
    model: stats.model,
    unit: "tokens_per_second",
    average_tokens_per_second: roundSpeed(stats.average_tokens_per_second),
    sample_count: stats.sample_count,
    updated_at: stats.updated_at
  };
}

export async function recordModelSpeedSample(
  env: Env,
  model: string,
  sample: { completion_tokens: number; latency_ms: number }
): Promise<void> {
  if (!Number.isFinite(sample.completion_tokens) || !Number.isFinite(sample.latency_ms)) {
    return;
  }

  const completionTokens = Math.floor(sample.completion_tokens);
  const latencyMs = Math.floor(sample.latency_ms);
  if (!model || completionTokens <= 0 || latencyMs <= 0) {
    return;
  }

  if (env.DB) {
    try {
      await upsertModelSpeedToD1(env.DB, model, completionTokens, latencyMs);
      return;
    } catch (error) {
      if (!isMissingD1TableError(error, "model_speed_stats")) {
        throw error;
      }
    }
  }

  const updatedAt = new Date().toISOString();
  const existing = await getFallbackModelSpeedStats(env, model);
  const next = mergeModelSpeedStats(existing, model, completionTokens, latencyMs, updatedAt);
  MEMORY_MODEL_SPEED.set(model, next);

  if (env.AI_GATEWAY_KV) {
    await env.AI_GATEWAY_KV.put(modelSpeedKey(model), JSON.stringify(next));
  }
}

async function getModelSpeedStats(env: Env, model: string): Promise<ModelSpeedStats | null> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT * FROM model_speed_stats WHERE model = ?").bind(model).first<D1Row>();
      return row ? modelSpeedStatsFromRow(row) : null;
    } catch (error) {
      if (!isMissingD1TableError(error, "model_speed_stats")) {
        throw error;
      }
    }
  }

  return getFallbackModelSpeedStats(env, model);
}

async function getFallbackModelSpeedStats(env: Env, model: string): Promise<ModelSpeedStats | null> {
  if (env.AI_GATEWAY_KV) {
    const stored = await env.AI_GATEWAY_KV.get(modelSpeedKey(model), "json");
    if (isModelSpeedStats(stored)) {
      return stored;
    }
  }

  return MEMORY_MODEL_SPEED.get(model) || null;
}

async function upsertModelSpeedToD1(
  db: D1Database,
  model: string,
  completionTokens: number,
  latencyMs: number
): Promise<void> {
  await db.prepare(`
    INSERT INTO model_speed_stats (
      model,
      sample_count,
      total_completion_tokens,
      total_latency_ms,
      average_tokens_per_second,
      updated_at
    ) VALUES (?, 1, ?, ?, (? * 1000.0 / ?), ?)
    ON CONFLICT(model) DO UPDATE SET
      sample_count = model_speed_stats.sample_count + 1,
      total_completion_tokens = model_speed_stats.total_completion_tokens + excluded.total_completion_tokens,
      total_latency_ms = model_speed_stats.total_latency_ms + excluded.total_latency_ms,
      average_tokens_per_second =
        (model_speed_stats.total_completion_tokens + excluded.total_completion_tokens) * 1000.0 /
        (model_speed_stats.total_latency_ms + excluded.total_latency_ms),
      updated_at = excluded.updated_at
  `).bind(
    model,
    completionTokens,
    latencyMs,
    completionTokens,
    latencyMs,
    new Date().toISOString()
  ).run();
}

function mergeModelSpeedStats(
  existing: ModelSpeedStats | null,
  model: string,
  completionTokens: number,
  latencyMs: number,
  updatedAt: string
): ModelSpeedStats {
  const totalCompletionTokens = (existing?.total_completion_tokens || 0) + completionTokens;
  const totalLatencyMs = (existing?.total_latency_ms || 0) + latencyMs;
  return {
    model,
    sample_count: (existing?.sample_count || 0) + 1,
    total_completion_tokens: totalCompletionTokens,
    total_latency_ms: totalLatencyMs,
    average_tokens_per_second: totalLatencyMs > 0 ? totalCompletionTokens * 1000 / totalLatencyMs : 0,
    updated_at: updatedAt
  };
}

function modelSpeedStatsFromRow(row: D1Row): ModelSpeedStats {
  return {
    model: stringValue(row.model),
    sample_count: numberValue(row.sample_count),
    total_completion_tokens: numberValue(row.total_completion_tokens),
    total_latency_ms: numberValue(row.total_latency_ms),
    average_tokens_per_second: numberValue(row.average_tokens_per_second),
    updated_at: stringValue(row.updated_at)
  };
}

function isModelSpeedStats(value: unknown): value is ModelSpeedStats {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stats = value as Partial<ModelSpeedStats>;
  return typeof stats.model === "string" && typeof stats.sample_count === "number";
}

function modelSpeedKey(model: string): string {
  return `${MODEL_SPEED_PREFIX}${model}`;
}

function roundSpeed(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value || 0);
}

function isMissingD1TableError(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes(`no such table: ${table.toLowerCase()}`);
}
