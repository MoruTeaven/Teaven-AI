import { invalidApiKey } from "../http/errors";
import type { Env } from "../types";

export const ADMIN_SESSION_COOKIE = "teaven_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

const SESSION_PREFIX = "teaven-admin-session";
const encoder = new TextEncoder();

export async function authenticateAdmin(request: Request, env: Env): Promise<void> {
  if (!env.ADMIN_TOKEN) {
    throw invalidApiKey("管理员认证未配置");
  }

  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1] === env.ADMIN_TOKEN) {
    return;
  }

  const session = readCookie(request, ADMIN_SESSION_COOKIE);
  if (session && (await verifyAdminSession(session, env.ADMIN_TOKEN))) {
    return;
  }

  throw invalidApiKey("管理员会话无效或已过期");
}

export async function verifyAdminPassword(password: string, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) {
    throw invalidApiKey("管理员认证未配置");
  }

  return password === env.ADMIN_TOKEN;
}

export async function createAdminSession(env: Env): Promise<string> {
  if (!env.ADMIN_TOKEN) {
    throw invalidApiKey("管理员认证未配置");
  }

  const issuedAt = Math.floor(Date.now() / 1000).toString();
  const signature = await signAdminSession(issuedAt, env.ADMIN_TOKEN);
  return `${issuedAt}.${signature}`;
}

async function verifyAdminSession(session: string, adminToken: string): Promise<boolean> {
  const [issuedAt, signature, extra] = session.split(".");
  if (!issuedAt || !signature || extra !== undefined) {
    return false;
  }

  const issuedAtSeconds = Number(issuedAt);
  if (!Number.isFinite(issuedAtSeconds)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAtSeconds > nowSeconds || nowSeconds - issuedAtSeconds > ADMIN_SESSION_TTL_SECONDS) {
    return false;
  }

  const expectedSignature = await signAdminSession(issuedAt, adminToken);
  return signature === expectedSignature;
}

async function signAdminSession(issuedAt: string, adminToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(adminToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${SESSION_PREFIX}.${issuedAt}`));
  return base64UrlEncode(signature);
}

function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return undefined;
  }

  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }

  return undefined;
}

function base64UrlEncode(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      result += chars[((b & 15) << 2) | (c >> 6)];
    }
    if (i + 2 < bytes.length) {
      result += chars[c & 63];
    }
  }
  return result;
}
