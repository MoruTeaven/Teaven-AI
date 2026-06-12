import { jsonResponse } from "../http/response";
import { upstreamError } from "../http/errors";
import type { ChatCompletionRequest, Env } from "../types";
import type { ProviderPlugin, ProviderPluginManifest, ProviderRequestContext } from "./types";

const MANIFEST: ProviderPluginManifest = {
  id: "openai-compatible",
  name: "OpenAI Compatible",
  version: "1.0.0",
  runtime: "in_process",
  capabilities: {
    "chat.completions": {
      execution_mode: "stream_or_sync",
      supports_stream: true
    }
  }
};

export function createOpenAICompatiblePlugin(_env: Env): ProviderPlugin {
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
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const baseUrl = context.credential.base_url || "https://api.openai.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/chat/completions");
  const upstreamRequest = {
    ...request,
    model: context.route.provider_model
  };

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

async function mapUpstreamError(response: Response): Promise<Error> {
  let message = `Upstream provider returned ${response.status}`;
  let code = "upstream_error";

  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    if (body.error?.message) {
      message = body.error.message;
    }
    if (body.error?.code) {
      code = String(body.error.code);
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

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
