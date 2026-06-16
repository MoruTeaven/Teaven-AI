import type { ChatCompletionRequest, Env, ImageGenerationRequest, ProviderRouteConfig } from "../types";

export type ExecutionMode = "sync" | "stream" | "stream_or_sync" | "async_polling" | "async_webhook";

export interface ProviderCapability {
  execution_mode: ExecutionMode;
  supports_stream?: boolean;
  result_delivery?: "direct" | "polling" | "webhook";
  poll_interval_seconds?: number;
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

export interface ProviderAdapter {
  manifest: ProviderPluginManifest;
  chatCompletions?: (request: ChatCompletionRequest, context: ProviderRequestContext) => Promise<Response>;
  imageGenerations?: (request: ImageGenerationRequest, context: ProviderRequestContext) => Promise<Response>;
  healthCheck?: (context: ProviderRequestContext) => Promise<void>;
}

export interface ProviderPlugin {
  manifest: ProviderPluginManifest;
  createAdapter: (env: Env) => ProviderAdapter;
}
