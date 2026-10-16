import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { createPgExecutor } from "../adapters/sql";
import { createR2S3 } from "../adapters/r2-s3";
import { buildEnv } from "./env-factory";
import gateway from "../index";
import { createId } from "../utils/ids";
import type { Env } from "../types";

/**
 * Node 自建入口（**当前生产形态**）：用 node-postgres + S3 组装 Env，
 * 复用 src/index.ts 的 fetch 处理全路由。.env 由 Node 22 的 --env-file 加载，无需 dotenv。
 *
 * 迁 celld 后本文件退役，由 src/server/celld-entry.ts 取代；两者共用 env-factory。
 */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const env = buildEnv({
    executor: createPgExecutor(pool),
    files: createR2S3(createS3(), process.env.S3_BUCKET || ""),
    vars: processEnvVars(),
  });
  const port = Number(process.env.PORT) || 3009;
  const server = createServer((req, res) => handleHttp(req, res, env));
  server.listen(port, () => console.log(`Teaven AI Gateway listening on :${port}`));
}

function createS3() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    },
  });
}

function processEnvVars(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of [
    "AUTH_MODE",
    "ADMIN_TOKEN",
    "USER_CENTER_TOKEN",
    "DEV_API_KEY",
    "MODEL_CONFIG_JSON",
    "PROVIDER_SECRET_ALLOWLIST",
    "ALLOW_INLINE_PROVIDER_CREDENTIALS",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_DEFAULT_MODEL",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "FILES_PUBLIC_BASE_URL",
    "API_ORIGIN",
  ] as const) {
    out[key] = process.env[key];
  }
  return out;
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
