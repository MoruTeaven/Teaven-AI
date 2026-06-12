import { invalidApiKey } from "../http/errors";
import type { AuthContext, Env } from "../types";

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  if (env.AUTH_MODE === "none") {
    return {
      tenant_id: "dev_tenant",
      api_key_id: "dev_key"
    };
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw invalidApiKey("Missing API key");
  }

  const token = match[1];
  if (!env.DEV_API_KEY) {
    throw invalidApiKey("API key authentication is not configured");
  }

  if (token !== env.DEV_API_KEY) {
    throw invalidApiKey();
  }

  return {
    tenant_id: "dev_tenant",
    api_key_id: "dev_key"
  };
}
