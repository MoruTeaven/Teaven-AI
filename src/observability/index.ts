import type { ObservabilityConfig, ObservabilityLogsConfig, ObservabilityTracesConfig } from "../types";

const DEFAULT_CONFIG: ObservabilityConfig = {
  enabled: false,
  head_sampling_rate: 1,
  logs: {
    enabled: true,
    head_sampling_rate: 1,
    persist: true,
    invocation_logs: true
  },
  traces: {
    enabled: false,
    persist: true,
    head_sampling_rate: 1
  }
};

export function getObservabilityConfig(config?: ObservabilityConfig): ObservabilityConfig {
  if (!config || !config.enabled) {
    return { ...DEFAULT_CONFIG, enabled: false };
  }

  return {
    enabled: true,
    head_sampling_rate: config.head_sampling_rate ?? DEFAULT_CONFIG.head_sampling_rate,
    logs: mergeLogsConfig(config.logs),
    traces: mergeTracesConfig(config.traces)
  };
}

function mergeLogsConfig(logs?: ObservabilityLogsConfig): ObservabilityLogsConfig {
  const defaults = DEFAULT_CONFIG.logs!;
  return {
    enabled: logs?.enabled ?? defaults.enabled,
    head_sampling_rate: logs?.head_sampling_rate ?? defaults.head_sampling_rate,
    persist: logs?.persist ?? defaults.persist,
    invocation_logs: logs?.invocation_logs ?? defaults.invocation_logs
  };
}

function mergeTracesConfig(traces?: ObservabilityTracesConfig): ObservabilityTracesConfig {
  const defaults = DEFAULT_CONFIG.traces!;
  return {
    enabled: traces?.enabled ?? defaults.enabled,
    persist: traces?.persist ?? defaults.persist,
    head_sampling_rate: traces?.head_sampling_rate ?? defaults.head_sampling_rate
  };
}

export function shouldLogInvocation(config: ObservabilityConfig): boolean {
  return !!(config.enabled && config.logs?.enabled && config.logs?.invocation_logs);
}

export function shouldPersistLogs(config: ObservabilityConfig): boolean {
  return !!(config.enabled && config.logs?.enabled && config.logs?.persist);
}

export function shouldTrace(config: ObservabilityConfig): boolean {
  return !!(config.enabled && config.traces?.enabled);
}

export function sampleLog(config: ObservabilityConfig): boolean {
  if (!config.enabled || !config.logs?.enabled) return false;
  const rate = config.logs.head_sampling_rate ?? 1;
  return Math.random() < rate;
}

export function sampleTrace(config: ObservabilityConfig): boolean {
  if (!config.enabled || !config.traces?.enabled) return false;
  const rate = config.traces.head_sampling_rate ?? 1;
  return Math.random() < rate;
}

export interface InvocationLog {
  request_id: string;
  organization_id?: string;
  api_key_id?: string;
  endpoint: string;
  method: string;
  model?: string;
  status_code: number;
  duration_ms: number;
  error?: unknown;
  timestamp: string;
}

export function createInvocationLog(
  requestId: string,
  endpoint: string,
  method: string,
  statusCode: number,
  durationMs: number,
  organizationId?: string,
  apiKeyId?: string,
  model?: string,
  error?: unknown
): InvocationLog {
  return {
    request_id: requestId,
    organization_id: organizationId,
    api_key_id: apiKeyId,
    endpoint,
    method,
    model,
    status_code: statusCode,
    duration_ms: durationMs,
    error,
    timestamp: new Date().toISOString()
  };
}