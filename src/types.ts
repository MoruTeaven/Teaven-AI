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
  FILES_PUBLIC_BASE_URL?: string;
  API_ORIGIN?: string;
}

export interface AuthContext {
  organization_id: string;
  api_key_id: string;
  allowed_models?: string[];
}

export type Modality = "text" | "image" | "video" | "file";

/**
 * 模型类型。
 * - ai: AI 大模型（如 GPT、Claude 等）
 * - traditional: 传统模型（如规则引擎、统计模型等）
 */
export type ModelType = "ai" | "traditional";

/**
 * 图片生成模式标签。
 * - text-to-image: 仅支持文生图
 * - image-to-image: 仅支持图生图
 * - both: 同时支持文生图和图生图
 */
export type ImageGenerationMode = "text-to-image" | "image-to-image" | "both";

export type UpstreamStatus = "active" | "disabled" | "degraded";
export type ModelStatus = "active" | "hidden" | "disabled";
export type UpstreamModelStatus = "active" | "hidden" | "disabled";
export type CredentialStatus = "active" | "disabled";

export type PriceUnit = "per_1m_tokens" | "per_call";

/**
 * 图片尺寸预设档位
 */
export interface ImageSizePreset {
  /** 档位名称，如 "1:1"、"16:9" */
  name: string;
  /** 宽度（像素） */
  width: number;
  /** 高度（像素） */
  height: number;
  /** 画质标签，如 "standard"、"hd" */
  quality?: string;
}

/**
 * 凭证配额的时间窗口。
 * - hour:  按小时刷新（整点重置，固定窗口）
 * - day:   按日固定额度（自然日重置）
 * - week:  按周固定额度（ISO 周重置）
 * - month: 按月固定额度（自然月重置）
 */
export type CredentialLimitWindow = "hour" | "day" | "week" | "month";

export interface CredentialLimit {
  window: CredentialLimitWindow;
  /** 窗口内最大请求数 */
  max_requests?: number;
  /** 窗口内最大 token 总量（尽力而为：调用前预检，调用后累加） */
  max_tokens?: number;
}

/**
 * 上游凭证条目。一个上游可以配置多个凭证，按权重加权随机挑选，
 * 每个凭证可独立设置配额上限，便于在多个 key 之间分摊用量。
 */
export interface UpstreamCredential {
  /**
   * 稳定跟踪 ID（用于日志、usage_records.credential_ref、async_tasks 事件，
   * 不要放真实密钥）。同一上游内必须唯一。
   */
  id: string;
  /** 显示名（可选），便于后台识别 */
  label?: string;
  /** 凭证引用：`env:SECRET_NAME` 或直接 key */
  credential_id: string;
  /** 权重，默认 1，>0 才参与抽取 */
  weight?: number;
  /** 配额上限列表，可同时配置多个窗口 */
  limits?: CredentialLimit[];
  status?: CredentialStatus;
}

export interface UpstreamModelConfig {
  alias: string;
  provider_model: string;
  modality: Modality;
  model_type?: ModelType;
  supports_stream?: boolean;
  supports_async?: boolean;
  /** 图片生成模式标签，仅 modality 为 image 时有效 */
  image_mode?: ImageGenerationMode;
  /** 支持的图片尺寸列表，仅 modality 为 image 时有效 */
  supported_image_sizes?: ImageSizePreset[];
  priority?: number;
  weight?: number;
  status?: UpstreamModelStatus;
  price?: string;
  price_unit?: PriceUnit;
}

export interface UpstreamConfig {
  id: string;
  name?: string;
  plugin_id: string;
  base_url?: string;
  credential_id?: string;
  /**
   * 多凭证池（可选）。配置后优先按权重加权随机挑选凭证，
   * 每个凭证可独立设置配额上限。未配置或为空时回退到 `credential_id` 单凭证。
   */
  credentials?: UpstreamCredential[];
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
  supports_async?: boolean;
  /** 图片生成模式标签，仅 modality 为 image 时有效 */
  image_mode?: ImageGenerationMode;
  /** 支持的图片尺寸列表，仅 modality 为 image 时有效 */
  supported_image_sizes?: ImageSizePreset[];
  priority?: number;
  weight?: number;
  status?: UpstreamModelStatus;
}

export interface ModelConfig {
  alias: string;
  modality: Modality;
  model_type?: ModelType;
  supports_stream?: boolean;
  supports_async?: boolean;
  /** 图片生成模式标签，仅 modality 为 image 时有效 */
  image_mode?: ImageGenerationMode;
  /** 支持的图片尺寸列表，仅 modality 为 image 时有效 */
  supported_image_sizes?: ImageSizePreset[];
  status?: ModelStatus;
  price?: string;
  price_unit?: PriceUnit;
  routes: ProviderRouteConfig[];
}

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
  /**
   * 模型分组（虚拟模型）。
   * 用户可以像调用普通模型一样调用组别名，
   * 网关按成员权重加权随机挑选一个真实模型执行。
   */
  model_groups?: ModelGroup[];
}

/**
 * 模型分组级别。
 * - advanced: 高级模型
 * - standard: 中级模型
 * - basic:    低级模型
 * - custom:   管理员自定义组
 */
export type ModelGroupLevel = "advanced" | "standard" | "basic" | "custom";

export interface ModelGroupMember {
  /** 引用现有模型别名，必须已在 upstreams 中定义 */
  alias: string;
  /** 权重，默认 1，>0 才参与抽取 */
  weight?: number;
}

export interface ModelGroup {
  /** 用户调用时填写的组别名，不可与现有模型 alias 冲突 */
  alias: string;
  /** 显示名 */
  name?: string;
  /** 分组级别 */
  level: ModelGroupLevel;
  /** 描述 */
  description?: string;
  /** 组模态，决定能被哪个接口调用 */
  modality: Modality;
  status?: "active" | "disabled";
  /** 失败回退成员别名，必须存在于 members 中 */
  fallback_member_alias?: string;
  members: ModelGroupMember[];
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
  /** 参考图片，支持 URL 或 base64 data URI。单张为字符串，多张为数组。 */
  image?: string | string[];
  /** 局部重绘遮罩图片，白色区域为重绘区域 */
  mask?: string;
  /** 重绘强度 0~1，值越大与原图差异越大 */
  strength?: number;
  /** 图生图模式 */
  mode?: "image-to-image" | "inpaint" | "style-transfer";
  image_count?: number;
  n?: number;
  /** 图片宽度（像素） */
  width?: number;
  /** 图片高度（像素） */
  height?: number;
  /** 图片比例，如 "1:1"、"16:9"，网关自动匹配到具体尺寸 */
  aspect_ratio?: string;
  /** 图片画质，如 "standard"、"hd"，网关自动匹配到具体尺寸 */
  quality?: string;
  /** 采样步数 */
  steps?: number;
  /** 提示词引导强度 */
  guidance_scale?: number;
  /** 反向提示词 */
  negative_prompt?: string;
  /** 随机种子 */
  seed?: number;
  /** 图片返回格式 */
  response_format?: "url" | "b64_json";
  /** 图片风格 */
  style?: string;
  /** Provider 原生参数透传区 */
  provider_params?: Record<string, unknown>;
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

export interface AsyncTaskEvent {
  at: string;
  stage: string;
  status?: AsyncTaskStatus;
  previous_status?: AsyncTaskStatus;
  provider_status?: string | null;
  provider_task_id?: string | null;
  provider_response_code?: string | null;
  poll_url?: string | null;
  http_status?: number;
  attempt?: number;
  delay_seconds?: number;
  process_id?: string;
  request_id?: string;
  /** 本次调用使用的凭证跟踪 ID（多 key 排错用） */
  credential_ref?: string | null;
  message?: string;
  error?: unknown;
  details?: Record<string, unknown>;
}

export interface AsyncTaskRecord {
  id: string;
  object: "task";
  organization_id: string;
  api_key_id: string;
  type: string;
  model: string;
  /** 用户请求里的原始 model 字段（可能是组别名）。对外展示用，内部处理使用 model。 */
  requested_model?: string;
  upstream_id?: string;
  plugin_id?: string;
  /** 本次任务使用的凭证跟踪 ID（形如 "{upstream_id}:{credential.id}"），多 key 排错用 */
  credential_ref?: string;
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
  events?: AsyncTaskEvent[];
  idempotency_key?: string;
  next_poll_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}
