import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

/**
 * R2 兼容层：Workers R2 的 get/put 适配到 S3 API（直连 CF R2 或自建 MinIO）。
 * - get(key) → { body: ReadableStream, writeHttpMetadata, httpEtag }
 * - put(key, body, { httpMetadata: { contentType } })
 * S3 endpoint 配成 R2 的 S3 兼容地址即可复用，无需改代码。
 */
export function createR2S3(client: S3Client, bucket: string) {
  return {
    async get(key: string) {
      try {
        const res = await client.send(new GetObjectCommand({ Key: key, Bucket: bucket }));
        if (!res.Body) return null;
        const nodeStream = res.Body as Readable;
        const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
        const etag = (res.ETag ?? "").replace(/"/g, "");
        return {
          body,
          httpEtag: etag,
          writeHttpMetadata(headers: Headers) {
            if (res.ContentType) headers.set("Content-Type", res.ContentType);
            if (res.CacheControl) headers.set("Cache-Control", res.CacheControl);
          },
        };
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async put(
      key: string,
      value: ReadableStream | Readable | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } }
    ): Promise<void> {
      const body = value instanceof ReadableStream ? Readable.fromWeb(value as unknown as import("node:stream/web").ReadableStream) : value;
      await client.send(new PutObjectCommand({
        Key: key,
        Bucket: bucket,
        Body: body as Readable | Uint8Array,
        ContentType: options?.httpMetadata?.contentType,
      }));
    },
  };
}
