import { loadSiteSettings } from "../admin/store";
import type { AsyncTaskOutputItem, Env } from "../types";

export const STORED_FILE_ROUTE_PREFIX = "/v1/files/";

export async function publicTaskOutput(
  output: AsyncTaskOutputItem[] | undefined,
  env: Env,
  requestUrl?: string
): Promise<AsyncTaskOutputItem[] | undefined> {
  if (!output) {
    return output;
  }

  const settings = await loadSiteSettings(env);
  const effectiveBaseUrl = settings.files_public_base_url || env.FILES_PUBLIC_BASE_URL;

  return output.map((item) => {
    if ((item.source !== "r2" && item.stored !== true) || typeof item.url !== "string") {
      return item;
    }

    const objectKey = normalizeStoredObjectKey(item.url, effectiveBaseUrl, requestUrl);
    if (!objectKey) {
      return item;
    }

    return {
      ...item,
      url: buildStoredFileUrl(objectKey, requestUrl ? undefined : effectiveBaseUrl, requestUrl)
    };
  });
}

export function buildStoredFileUrl(objectKey: string, filesPublicBaseUrl: string | undefined, requestUrl?: string): string {
  const normalizedKey = normalizeObjectKey(objectKey);
  const publicBaseUrl = normalizeBaseUrl(filesPublicBaseUrl);
  if (publicBaseUrl) {
    return joinUrl(publicBaseUrl, encodeObjectKey(normalizedKey));
  }

  const origin = requestUrl ? readOrigin(requestUrl) : undefined;
  if (origin) {
    return joinUrl(origin, `${STORED_FILE_ROUTE_PREFIX}${encodeObjectKey(normalizedKey)}`);
  }

  return normalizedKey;
}

export function normalizeStoredObjectKey(value: string, filesPublicBaseUrl: string | undefined, requestUrl?: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const publicBaseUrl = normalizeBaseUrl(filesPublicBaseUrl);
  const keyFromPublicBase = readObjectKeyFromBaseUrl(trimmed, publicBaseUrl);
  if (keyFromPublicBase) {
    return keyFromPublicBase;
  }

  const origin = requestUrl ? readOrigin(requestUrl) : undefined;
  const proxyBaseUrl = origin ? joinUrl(origin, STORED_FILE_ROUTE_PREFIX) : undefined;
  const keyFromProxyUrl = readObjectKeyFromBaseUrl(trimmed, proxyBaseUrl);
  if (keyFromProxyUrl) {
    return keyFromProxyUrl;
  }

  if (isAbsoluteUrl(trimmed)) {
    return undefined;
  }

  return normalizeObjectKey(trimmed);
}

function normalizeObjectKey(value: string): string {
  return value.replace(/^\/+/, "");
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function readOrigin(requestUrl: string): string | undefined {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return undefined;
  }
}

function readObjectKeyFromBaseUrl(value: string, baseUrl: string | undefined): string | undefined {
  if (!baseUrl || !isAbsoluteUrl(value)) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

    if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) {
      return undefined;
    }

    return normalizeObjectKey(decodeURIComponent(url.pathname.slice(basePath.length)));
  } catch {
    return undefined;
  }
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
