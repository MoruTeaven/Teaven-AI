import type { AsyncTaskOutputItem, AsyncTaskRecord, AsyncTaskStatus, ChatCompletionRequest, Env, ImageGenerationRequest, ProviderRouteConfig } from "../types";

export type ExecutionMode = "sync" | "stream" | "stream_or_sync" | "async_polling" | "async_webhook";

export interface ProviderCapability {
  execution_mode: ExecutionMode;
  supports_stream?: boolean;
  result_delivery?: "direct" | "polling" | "webhook";
  poll_interval_seconds?: number;
}

export interface AsyncTaskResponse {
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  [key: string]: unknown;
}

export interface ProviderPluginManifest {
  id: string;
  name: string;
  version: string;
  runtime: "in_process" | "remote_http";
  capabilities: Record<string, ProviderCapability>;
}

export interface ProviderCredential {
  id: string;
  plugin_id: string;
  api_key?: string;
  base_url?: string;
  config?: Record<string, unknown>;
}

export interface ProviderRequestContext {
  env: Env;
  request_id: string;
  route: ProviderRouteConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
}

/**
 * 上游任务轮询返回结果，由各 Provider 的 pollTask 方法返回。
 * consumer 根据此结果决定下一步：完成、失败、或继续轮询。
 */
export interface TaskPollResult {
  /** 上游任务当前状态 */
  status: AsyncTaskStatus;
  /** 上游原始状态，便于排查状态映射问题 */
  provider_status?: string;
  /** 上游响应码或业务码 */
  provider_response_code?: string;
  /** 轮询请求的 HTTP 状态码 */
  http_status?: number;
  /** 上游返回的简短消息 */
  message?: string;
  /** 任务成功时的输出列表（图片URL、视频URL等） */
  output?: AsyncTaskOutputItem[];
  /** 任务失败时的错误信息 */
  error?: unknown;
  /** 上游最新的任务ID（某些 provider 可能在处理过程中更新 ID） */
  provider_task_id?: string;
  /** 建议的下次轮询间隔秒数，不填则使用 manifest 中的默认值 */
  poll_after_seconds?: number;
}

export interface ProviderAdapter {
  manifest: ProviderPluginManifest;
  chatCompletions?: (request: ChatCompletionRequest, context: ProviderRequestContext) => Promise<Response>;
  imageGenerations?: (request: ImageGenerationRequest, context: ProviderRequestContext) => Promise<Response>;
  healthCheck?: (context: ProviderRequestContext) => Promise<void>;
  /**
   * 轮询上游异步任务状态。
   * consumer 调用此方法获取上游任务最新状态和结果。
   * @param providerTaskId 上游返回的任务ID
   * @param taskRecord 网关侧完整任务记录
   * @param context 请求上下文（包含凭据、base_url 等）
   */
  pollTask?: (providerTaskId: string, taskRecord: AsyncTaskRecord, context: ProviderRequestContext) => Promise<TaskPollResult>;
}

export interface ProviderPlugin {
  manifest: ProviderPluginManifest;
  createAdapter: (env: Env) => ProviderAdapter;
}
