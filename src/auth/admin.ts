import { invalidApiKey } from "../http/errors";
import type { Env } from "../types";

export function authenticateAdmin(request: Request, env: Env): void {
  if (!env.ADMIN_TOKEN) {
    throw invalidApiKey("管理员认证未配置");
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== env.ADMIN_TOKEN) {
    throw invalidApiKey("管理员令牌无效");
  }
}
