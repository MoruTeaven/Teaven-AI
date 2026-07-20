export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: ErrorType;
  readonly param: string | null;
  /** 给调用方的可操作排错建议（可选），不会本地化展示，便于客户端直接展示给最终用户 */
  readonly hint: string | null;

  constructor(status: number, code: string, message: string, type: ErrorType = "api_error", param: string | null = null, hint: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
    this.hint = hint;
  }
}

export function invalidRequest(message: string, param: string | null = null, code = "invalid_request"): ApiError {
  return new ApiError(400, code, message, "invalid_request_error", param);
}

export function invalidApiKey(message = "Invalid API key", hint: string | null = null): ApiError {
  return new ApiError(401, "invalid_api_key", message, "authentication_error", null, hint);
}

export function permissionDenied(message = "Permission denied"): ApiError {
  return new ApiError(403, "permission_denied", message, "permission_error");
}

export function notFound(message = "Resource not found"): ApiError {
  return new ApiError(404, "not_found", message, "invalid_request_error");
}

export function conflict(message: string, code = "task_state_conflict"): ApiError {
  return new ApiError(409, code, message, "invalid_request_error");
}

export function providerUnavailable(message = "Provider unavailable"): ApiError {
  return new ApiError(503, "provider_unavailable", message, "api_error");
}

export function upstreamError(message = "Upstream provider error", status = 502, code = "upstream_error"): ApiError {
  return new ApiError(status, code, message, "api_error");
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    return new ApiError(500, "internal_error", error.message || "Internal server error", "api_error");
  }

  return new ApiError(500, "internal_error", "Internal server error", "api_error");
}
