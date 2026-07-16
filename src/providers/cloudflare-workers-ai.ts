import { jsonResponse } from "../http/response";
import { upstreamError } from "../http/errors";
import type { ChatCompletionRequest, Env } from "../types";
import type { ProviderPlugin, ProviderPluginManifest, ProviderRequestContext } from "./types";

const MANIFEST: ProviderPluginManifest = {
  id: "cloudflare-workers-ai",
  name: "Cloudflare Workers AI",
  version: "1.0.0",
  runtime: "in_process",
  capabilities: {
    "chat": {
      execution_mode: "stream_or_sync",
      supports_stream: true
    }
  }
};

export function createCloudflareWorkersAIPlugin(_env: Env): ProviderPlugin {
  return {
    manifest: MANIFEST,
    createAdapter() {
      return {
        manifest: MANIFEST,
        async chatCompletions(request: ChatCompletionRequest, context: ProviderRequestContext): Promise<Response> {
          return forwardChatCompletion(request, context);
        }
      };
    }
  };
}

async function forwardChatCompletion(request: ChatCompletionRequest, context: ProviderRequestContext): Promise<Response> {
  const apiToken = context.credential.api_key;
  if (!apiToken) {
    throw upstreamError("Cloudflare API token is missing", 503, "provider_unavailable");
  }

  const upstreamUrl = buildChatCompletionsUrl(context);
  const upstreamRequest = {
    ...request,
    model: context.route.provider_model
  };

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "X-Request-Id": context.request_id
    },
    body: JSON.stringify(upstreamRequest),
    signal: context.signal
  });

  if (!upstream.ok) {
    throw await mapUpstreamError(upstream);
  }

  if (request.stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Request-Id": context.request_id
      }
    });
  }

  const data = (await upstream.json()) as Record<string, unknown>;
  data.model = request.model;
  return jsonResponse(data, {
    status: 200,
    headers: {
      "X-Request-Id": context.request_id
    }
  });
}

function buildChatCompletionsUrl(context: ProviderRequestContext): string {
  if (context.credential.base_url) {
    return joinUrl(context.credential.base_url, "/chat/completions");
  }

  const accountId = stringConfig(context.route.config, "account_id") || context.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw upstreamError("Cloudflare account_id is missing", 503, "provider_unavailable");
  }

  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
}

async function mapUpstreamError(response: Response): Promise<Error> {
  let message = `Cloudflare Workers AI returned ${response.status}`;
  let code = "upstream_error";

  try {
    const body = (await response.json()) as {
      errors?: Array<{ message?: string; code?: string | number }>;
      error?: { message?: string; code?: string | number };
    };
    const cloudflareError = Array.isArray(body.errors) ? body.errors[0] : undefined;
    if (body.error?.message) {
      message = body.error.message;
    } else if (cloudflareError?.message) {
      message = cloudflareError.message;
    }
    if (body.error?.code) {
      code = String(body.error.code);
    } else if (cloudflareError?.code) {
      code = String(cloudflareError.code);
    }
  } catch {
    const text = await response.text().catch(() => "");
    if (text) {
      message = text.slice(0, 500);
    }
  }

  const status = response.status >= 400 && response.status < 500 ? response.status : 502;
  return upstreamError(message, status, code);
}

function stringConfig(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
