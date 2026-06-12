import { invalidRequest } from "../http/errors";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw invalidRequest("Content-Type must be application/json");
  }

  let data: unknown;
  try {
    data = await request.json();
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw invalidRequest("Request body must be a JSON object");
  }

  return data as Record<string, unknown>;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidRequest(`${name} is required`, name);
  }
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidRequest(`${name} must be a string`, name);
  }
  return value;
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${name} must be an object`, name);
  }
  return value as Record<string, unknown>;
}
