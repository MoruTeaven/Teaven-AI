import { invalidApiKey } from "../http/errors";
import { findAdminApiKeyByToken, getAdminUser, touchAdminApiKey } from "../admin/store";
import type { AuthContext, Env } from "../types";

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  if (env.AUTH_MODE === "none") {
    return {
      organization_id: "dev_organization",
      api_key_id: "dev_key"
    };
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw invalidApiKey("Missing API key");
  }

  const token = match[1];
  if (env.DEV_API_KEY && token === env.DEV_API_KEY) {
    return {
      organization_id: "dev_organization",
      api_key_id: "dev_key"
    };
  }

  const managedKey = await findAdminApiKeyByToken(env, token);
  if (!managedKey) {
    throw invalidApiKey(env.DEV_API_KEY ? undefined : "API key authentication is not configured");
  }

  if (managedKey.status !== "active") {
    throw invalidApiKey("API key is disabled");
  }
  if (managedKey.expires_at && managedKey.expires_at < new Date().toISOString()) {
    throw invalidApiKey("API key is expired");
  }

  const user = await getAdminUser(env, managedKey.user_id);
  if (!user || user.status !== "active") {
    throw invalidApiKey("API key user is disabled");
  }

  await touchAdminApiKey(env, managedKey);

  return {
    organization_id: managedKey.organization_id,
    api_key_id: managedKey.id,
    allowed_models: managedKey.allowed_models
  };
}