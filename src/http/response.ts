import { toApiError } from "./errors";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,idempotency-key",
  "Access-Control-Max-Age": "86400"
};

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function emptyResponse(init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(null, { ...init, headers });
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  const apiError = toApiError(error);
  return jsonResponse(
    {
      error: {
        message: apiError.message,
        type: apiError.type,
        param: apiError.param,
        code: apiError.code
      }
    },
    {
      status: apiError.status,
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}
