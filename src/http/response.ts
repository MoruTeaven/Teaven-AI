import { toApiError } from "./errors";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,idempotency-key",
  "Access-Control-Max-Age": "86400"
};

const ALLOWED_FRONTEND_HOSTS = ["moruteaven.com", "moruteaven.qzz.io"];

export function jsonResponse(data: unknown, init: ResponseInit = {}, request?: Request): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  applyCorsHeaders(headers, request);

  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function emptyResponse(init: ResponseInit = {}, request?: Request): Response {
  const headers = new Headers(init.headers);
  applyCorsHeaders(headers, request);
  return new Response(null, { ...init, headers });
}

export function withCors(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, request);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function applyCorsHeaders(headers: Headers, request?: Request): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  headers.delete("Access-Control-Allow-Origin");

  const origin = request?.headers.get("Origin") || null;
  const allowedOrigin = getAllowedCorsOrigin(origin);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    appendVary(headers, "Origin");
  }
}

function getAllowedCorsOrigin(origin: string | null): string | undefined {
  if (!origin) {
    return undefined;
  }

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalDevelopmentHost(hostname))) {
      return undefined;
    }
    if (isLocalDevelopmentHost(hostname) || ALLOWED_FRONTEND_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      return url.origin;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }

  const values = current.split(",").map((item) => item.trim().toLowerCase());
  if (!values.includes("*") && !values.includes(value.toLowerCase())) {
    headers.set("Vary", `${current}, ${value}`);
  }
}

export function errorResponse(error: unknown, requestId: string, request?: Request): Response {
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
    },
    request
  );
}
