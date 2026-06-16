import { findAdminUserByEmail, getAdminUser, type AdminUser } from "../admin/store";
import { invalidApiKey } from "../http/errors";
import type { Env } from "../types";

export const ACCOUNT_SESSION_COOKIE = "teaven_account_session";
export const ACCOUNT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const SESSION_PREFIX = "teaven-account-session";
const encoder = new TextEncoder();

export async function authenticateAccount(request: Request, env: Env): Promise<AdminUser> {
  const secret = getAccountSecret(env);
  if (!secret) {
    throw invalidApiKey("用户中心未配置 USER_CENTER_TOKEN");
  }

  const session = readCookie(request, ACCOUNT_SESSION_COOKIE);
  const userId = session ? await verifyAccountSession(session, secret) : undefined;
  if (!userId) {
    throw invalidApiKey("用户会话无效或已过期");
  }

  const user = await getAdminUser(env, userId);
  if (!user || user.status !== "active") {
    throw invalidApiKey("用户不存在或已禁用");
  }

  return user;
}

export async function findAccountUser(env: Env, email: string): Promise<AdminUser | undefined> {
  return findAdminUserByEmail(env, email);
}

export async function verifyAccountAccessToken(token: string, env: Env): Promise<boolean> {
  const secret = getAccountSecret(env);
  return Boolean(secret) && token === secret;
}

export async function createAccountSession(env: Env, userId: string): Promise<string> {
  const secret = getAccountSecret(env);
  if (!secret) {
    throw invalidApiKey("用户中心未配置 USER_CENTER_TOKEN");
  }

  const issuedAt = Math.floor(Date.now() / 1000).toString();
  const signature = await signAccountSession(userId, issuedAt, secret);
  return `${userId}.${issuedAt}.${signature}`;
}

export function isAccountCenterConfigured(env: Env): boolean {
  return Boolean(getAccountSecret(env));
}

function getAccountSecret(env: Env): string | undefined {
  return env.USER_CENTER_TOKEN || env.ADMIN_TOKEN;
}

async function verifyAccountSession(session: string, secret: string): Promise<string | undefined> {
  const [userId, issuedAt, signature, extra] = session.split(".");
  if (!userId || !issuedAt || !signature || extra !== undefined) {
    return undefined;
  }

  const issuedAtSeconds = Number(issuedAt);
  if (!Number.isFinite(issuedAtSeconds)) {
    return undefined;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (issuedAtSeconds > nowSeconds || nowSeconds - issuedAtSeconds > ACCOUNT_SESSION_TTL_SECONDS) {
    return undefined;
  }

  const expectedSignature = await signAccountSession(userId, issuedAt, secret);
  return signature === expectedSignature ? userId : undefined;
}

async function signAccountSession(userId: string, issuedAt: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${SESSION_PREFIX}.${userId}.${issuedAt}`));
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
  let binary = "";
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
