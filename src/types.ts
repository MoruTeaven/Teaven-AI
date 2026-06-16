export interface AsyncTaskQueueMessage {
  task_id: string;
}

export interface Env {
  DB?: D1Database;
  AI_GATEWAY_KV?: KVNamespace;
  FILES?: R2Bucket;
  TASK_QUEUE?: Queue<AsyncTaskQueueMessage>;
  AUTH_MODE?: string;
  ADMIN_TOKEN?: string;
  USER_CENTER_TOKEN?: string;
  DEV_API_KEY?: string;
  MODEL_CONFIG_JSON?: string;
  OPENAI_COMPATIBLE_API_KEY?: string;
  OPENAI_COMPATIBLE_BASE_URL?: string;
  OPENAI_COMPATIBLE_DEFAULT_MODEL?: string;
}

export interface AuthContext {
  tenant_id: string;
  api_key_id: string;
  allowed_models?: string[];
}

export type Modality = "text" | "image" | "video" | "file";

export type UpstreamStatus = "active" | "disabled" | "degraded";
export type ModelStatus = "active" | "hidden" | "disabled";
export type UpstreamModelStatus = "active" | "hidden" | "disabled";

export interface UpstreamModelConfig {
  alias: string;
  provider_model: string;
  modality: Modality;
  supports_stream?: boolean;
  priority?: number;
  weight?: number;
  status?: UpstreamModelStatus;
}

export interface UpstreamConfig {
  id: string;
  name?: string;
  plugin_id: string;
  base_url?: string;
  credential_id?: string;
  config?: Record<string, unknown>;
  status?: UpstreamStatus;
  models: UpstreamModelConfig[];
}

export interface ProviderRouteConfig {
  upstream_id: string;
  upstream_name?: string;
  plugin_id: string;
  provider_model: string;
  credential_id?: string;
  base_url?: string;
  config?: Record<string, unknown>;
  modality: Modality;
  supports_stream?: boolean;
  priority?: number;
  weight?: number;
  status?: UpstreamModelStatus;
}

export interface ModelConfig {
  alias: string;
  modality: Modality;
  supports_stream?: boolean;
  status?: ModelStatus;
  routes: ProviderRouteConfig[];
}

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  quality?: string;
  style?: string;
  [key: string]: unknown;
}

export type AsyncTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export interface AsyncTaskOutputItem {
  type: string;
  url?: string;
  stored?: boolean;
  source?: "r2" | "upstream";
  expires_at?: string | null;
  [key: string]: unknown;
}

export interface AsyncTaskRecord {
  id: string;
  object: "task";
  tenant_id: string;
  api_key_id: string;
  type: string;
  model: string;
  upstream_id?: string;
  plugin_id?: string;
  provider_execution_mode?: string;
  provider_task_id?: string;
  provider_context?: Record<string, unknown>;
  status: AsyncTaskStatus;
  input: Record<string, unknown>;
  output?: AsyncTaskOutputItem[];
  store_output: boolean;
  storage_ttl_seconds: number;
  output_expires_at?: string | null;
  callback_url?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
  idempotency_key?: string;
  next_poll_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}
