import { invalidApiKey } from "../http/errors";
import { findAdminApiKeyByToken, getAdminUser, touchAdminApiKey } from "../admin/store";
import type { AuthContext, Env } from "../types";

const AUTH_HEADER_HINT = "Send an 'Authorization: Bearer <YOUR_API_KEY>' header. Create or rotate API keys from the account page (/account).";

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  if (env.AUTH_MODE === "none") {
    return {
      organization_id: "dev_organization",
      api_key_id: "dev_key"
    };
  }

  const authorization = request.headers.get("Authorization") || "";

  if (!authorization) {
    throw invalidApiKey("Missing Authorization header. An API key is required to call this endpoint.", AUTH_HEADER_HINT);
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    // 区分两类常见错误：错误的 scheme（如 Basic）和缺空格的格式错误
    const looksLikeOtherScheme = /^(basic|digest|token|apikey|x-api-key)\s/i.test(authorization);
    if (looksLikeOtherScheme) {
      throw invalidApiKey(
        "Unsupported Authorization scheme. Only 'Bearer' is accepted.",
        "Use 'Authorization: Bearer <YOUR_API_KEY>' instead of other schemes such as Basic."
      );
    }
    throw invalidApiKey(
      "Malformed Authorization header. Expected 'Bearer <YOUR_API_KEY>'.",
      AUTH_HEADER_HINT
    );
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
    if (env.DEV_API_KEY) {
      throw invalidApiKey(
        "Invalid API key. The provided token does not match any active key.",
        "Check that the key is copied in full without surrounding whitespace. You can also use the dev key (DEV_API_KEY) for local testing."
      );
    }
    throw invalidApiKey(
      "Invalid API key.",
      "Verify the key value, or sign in to the account page (/account) to create a new API key."
    );
  }

  if (managedKey.status !== "active") {
    throw invalidApiKey(
      `API key is ${managedKey.status} and cannot be used.`,
      "Sign in to the account page (/account) and enable this key, or create a new one."
    );
  }
  if (managedKey.expires_at && managedKey.expires_at < new Date().toISOString()) {
    throw invalidApiKey(
      "API key has expired.",
      "Sign in to the account page (/account) and create a new key, or extend the expiration of this key."
    );
  }

  const user = await getAdminUser(env, managedKey.user_id);
  if (!user || user.status !== "active") {
    throw invalidApiKey(
      "The account that owns this API key is disabled.",
      "Contact the site administrator to re-enable the account, or sign in with another account and create a new key."
    );
  }

  await touchAdminApiKey(env, managedKey);

  return {
    organization_id: managedKey.organization_id,
    api_key_id: managedKey.id,
    allowed_models: managedKey.allowed_models
  };
}
