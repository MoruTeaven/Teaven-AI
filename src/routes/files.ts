import { loadSiteSettings } from "../admin/store";
import { notFound } from "../http/errors";
import { normalizeStoredObjectKey } from "../tasks/output";
import { getTask } from "../tasks/store";
import type { AsyncTaskRecord, AuthContext, Env } from "../types";

export async function handleGetFile(
  rawObjectKey: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
  requestUrl?: string
): Promise<Response> {
  const settings = await loadSiteSettings(env);
  const effectiveBaseUrl = settings.files_public_base_url || env.FILES_PUBLIC_BASE_URL;
  const objectKey = decodeObjectKey(rawObjectKey, effectiveBaseUrl, requestUrl);
  const taskId = readTaskIdFromObjectKey(objectKey);
  if (!taskId) {
    throw notFound("File not found");
  }

  const task = await getTask(env, taskId);
  if (!task || task.organization_id !== auth.organization_id || !taskReferencesObjectKey(task, objectKey, effectiveBaseUrl, requestUrl)) {
    throw notFound("File not found");
  }
  if (task.output_expires_at && task.output_expires_at <= new Date().toISOString()) {
    throw notFound("File not found");
  }

  if (!env.FILES) {
    throw notFound("File not found");
  }

  const object = await env.FILES.get(objectKey);
  if (!object) {
    throw notFound("File not found");
  }

  const headers = new Headers({
    "Cache-Control": "private, max-age=300",
    "X-Request-Id": requestId
  });
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);

  return new Response(object.body, { headers });
}

function decodeObjectKey(value: string, effectiveBaseUrl: string | undefined, requestUrl?: string): string {
  try {
    const objectKey = normalizeStoredObjectKey(decodeURIComponent(value), effectiveBaseUrl, requestUrl);
    if (objectKey) {
      return objectKey;
    }
  } catch {
    // Fall through to the generic 404 below.
  }
  throw notFound("File not found");
}

function readTaskIdFromObjectKey(objectKey: string): string | undefined {
  return objectKey.match(/^tasks\/([^/]+)\/[^/]+$/)?.[1];
}

function taskReferencesObjectKey(task: AsyncTaskRecord, objectKey: string, effectiveBaseUrl: string | undefined, requestUrl?: string): boolean {
  return (task.output || []).some((item) => {
    if ((item.source !== "r2" && item.stored !== true) || typeof item.url !== "string") {
      return false;
    }
    return normalizeStoredObjectKey(item.url, effectiveBaseUrl, requestUrl) === objectKey;
  });
}
