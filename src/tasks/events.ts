import type { AsyncTaskEvent, AsyncTaskRecord } from "../types";

const MAX_TASK_EVENTS = 100;

export function appendTaskEvent(
  task: AsyncTaskRecord,
  event: Omit<AsyncTaskEvent, "at"> & { at?: string }
): void {
  const nextEvent: AsyncTaskEvent = {
    ...event,
    at: event.at || new Date().toISOString()
  };
  const events = Array.isArray(task.events) ? task.events : [];
  task.events = [...events, nextEvent].slice(-MAX_TASK_EVENTS);
}

export function taskDiagnostics(task: AsyncTaskRecord): Record<string, unknown> {
  const providerContext = task.provider_context || {};
  return {
    upstream_id: task.upstream_id || null,
    plugin_id: task.plugin_id || null,
    provider_execution_mode: task.provider_execution_mode || null,
    provider_task_id: task.provider_task_id || null,
    provider_status: stringOrNull(providerContext._last_provider_status),
    provider_response_code: stringOrNull(providerContext._last_provider_code),
    provider_http_status: numberOrNull(providerContext._last_http_status),
    poll_count: numberOrZero(providerContext._poll_count),
    create_attempt_count: numberOrZero(providerContext._create_attempt_count),
    last_poll_at: stringOrNull(providerContext._last_poll_at),
    next_poll_at: task.next_poll_at || null,
    last_error: providerContext._last_error ?? null,
    last_event: lastTaskEvent(task)
  };
}

export function lastTaskEvent(task: AsyncTaskRecord): AsyncTaskEvent | null {
  return task.events?.[task.events.length - 1] || null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) || 0;
}
