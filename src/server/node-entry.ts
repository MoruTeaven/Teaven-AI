import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { createD1Pg } from "../adapters/d1-pg";
import { createKvPg } from "../adapters/kv-pg";
import { createR2S3 } from "../adapters/r2-s3";
import { createTaskQueue } from "../adapters/task-queue";
import gateway from "../index";
import { createId } from "../utils/ids";
import type { Env } from "../types";

/**
 * Node 自建入口：用 pg/S3 适配层构造 Env，复用 index.ts 的 fetch 处理全路由。
 * .env 由 Node 22 的 --env-file 加载，无需 dotenv。
 * 启动：node --env-file=.env dist/server/node-entry.js
 */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const env = buildEnv(pool);
  const port = Number(process.env.PORT) || 3009;
  const server = createServer((req, res) => handleHttp(req, res, env));
  server.listen(port, () => console.log(`Teaven AI Gateway listening on :${port}`));
}

function buildEnv(pool: Pool): Env {
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    },
  });
  const env: Record<string, unknown> = {
    DB: createD1Pg(pool),
    AI_GATEWAY_KV: createKvPg(pool),
    FILES: createR2S3(s3, process.env.S3_BUCKET || ""),
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    USER_CENTER_TOKEN: process.env.USER_CENTER_TOKEN,
    DEV_API_KEY: process.env.DEV_API_KEY,
    MODEL_CONFIG_JSON: process.env.MODEL_CONFIG_JSON,
    PROVIDER_SECRET_ALLOWLIST: process.env.PROVIDER_SECRET_ALLOWLIST,
    ALLOW_INLINE_PROVIDER_CREDENTIALS: process.env.ALLOW_INLINE_PROVIDER_CREDENTIALS,
    OPENAI_COMPATIBLE_API_KEY: process.env.OPENAI_COMPATIBLE_API_KEY,
    OPENAI_COMPATIBLE_BASE_URL: process.env.OPENAI_COMPATIBLE_BASE_URL,
    OPENAI_COMPATIBLE_DEFAULT_MODEL: process.env.OPENAI_COMPATIBLE_DEFAULT_MODEL,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    FILES_PUBLIC_BASE_URL: process.env.FILES_PUBLIC_BASE_URL,
    API_ORIGIN: process.env.API_ORIGIN,
    AUTH_MODE: process.env.AUTH_MODE,
  };
  env.TASK_QUEUE = createTaskQueue(env as Env, pool);
  return env as Env;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, env: Env) {
  const requestId = createId("req");
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const method = req.method || "GET";
    let body: ReadableStream<Uint8Array> | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
          req.on("end", () => controller.close());
          req.on("error", (e) => controller.error(e));
        },
      });
    }
    const request = new Request(url, {
      method,
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    const response = await gateway.fetch(request, env);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
  } catch (error) {
    console.error(`[${requestId}] ${req.method} ${req.url}:`, error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "internal_error", request_id: requestId }));
    }
  }
}

main();
