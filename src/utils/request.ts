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

/**
 * 图片输入的标准化形式。
 */
export interface ImageInput {
  /** 图片来源类型 */
  source: "url" | "base64";
  /** URL 地址（source=url 时有值） */
  url?: string;
  /** base64 数据（source=base64 时有值，包含 data:image/...;base64, 前缀） */
  data?: string;
  /** MIME 类型 */
  mime_type?: string;
}

/** 单张图片最大 20MB */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
/** 支持的图片 MIME 类型 */
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * 将用户传入的图片值解析为标准 ImageInput。
 * - URL（https://...）→ source: "url"
 * - base64（data:image/...;base64,...）→ source: "base64"
 */
export function resolveImageInput(value: unknown): ImageInput | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidRequest("image must be a string (URL or base64 data URI)", "image");
  }

  // base64 data URI
  if (value.startsWith("data:")) {
    const match = value.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw invalidRequest("Invalid base64 data URI format", "image");
    }
    const mimeType = match[1];
    const base64Data = match[2];
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      throw invalidRequest(`Unsupported image type: ${mimeType}. Supported: ${[...SUPPORTED_IMAGE_TYPES].join(", ")}`, "image");
    }
    // 估算原始大小（base64 编码后约增加 33%）
    const estimatedSize = Math.floor(base64Data.length * 3 / 4);
    if (estimatedSize > MAX_IMAGE_SIZE) {
      throw invalidRequest(`Image too large: ${Math.round(estimatedSize / 1024 / 1024)}MB (max ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`, "image");
    }
    return { source: "base64", data: value, mime_type: mimeType };
  }

  // URL
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return { source: "url", url: value };
  }

  throw invalidRequest("image must be a valid URL (https://...) or base64 data URI (data:image/...;base64,...)", "image");
}

/**
 * 校验图片输入数组。
 * 支持单张（string）或多张（string[]）。
 */
export function resolveImageInputs(value: unknown): ImageInput[] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    const input = resolveImageInput(value);
    return input ? [input] : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    if (value.length > 10) {
      throw invalidRequest("Maximum 10 reference images allowed", "image");
    }
    return value.map((item, index) => {
      const input = resolveImageInput(item);
      if (!input) {
        throw invalidRequest(`image[${index}] is invalid`, "image");
      }
      return input;
    });
  }
  throw invalidRequest("image must be a string or array of strings", "image");
}

/**
 * 解析 multipart/form-data 请求。
 */
export interface MultipartParseResult {
  fields: Record<string, string>;
  files: Record<string, MultipartFile>;
}

export interface MultipartFile {
  name: string;
  type: string;
  data: ArrayBuffer;
}

const MAX_MULTIPART_SIZE = 50 * 1024 * 1024; // 50MB

export async function readMultipartRequest(request: Request): Promise<MultipartParseResult> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw invalidRequest("Content-Type must be multipart/form-data");
  }

  const formData = await request.formData();
  const fields: Record<string, string> = {};
  const files: Record<string, MultipartFile> = {};
  let totalSize = 0;

  formData.forEach((value, key) => {
    if (value instanceof File) {
      totalSize += value.size;
      if (totalSize > MAX_MULTIPART_SIZE) {
        throw invalidRequest(`Total upload size exceeds ${Math.round(MAX_MULTIPART_SIZE / 1024 / 1024)}MB limit`, "multipart");
      }
      if (value.size > MAX_IMAGE_SIZE) {
        throw invalidRequest(`File ${key} too large: ${Math.round(value.size / 1024 / 1024)}MB (max ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`, key);
      }
      const mimeType = value.type || "application/octet-stream";
      if (key === "image" || key === "mask") {
        if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
          throw invalidRequest(`Unsupported image type for ${key}: ${mimeType}`, key);
        }
      }
      // Note: We can't use await inside forEach, so we store the File directly
      // The caller will need to handle conversion
      files[key] = {
        name: value.name,
        type: mimeType,
        data: value as unknown as ArrayBuffer // Will be resolved by caller
      };
    } else {
      fields[key] = value;
    }
  });

  return { fields, files };
}

/**
 * 将 File 对象转换为 base64 data URI。
 */
export function fileToBase64(file: MultipartFile): string {
  const bytes = new Uint8Array(file.data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return `data:${file.type};base64,${base64}`;
}
