import { authenticate } from "./auth/api-key";
import { errorResponse, emptyResponse, jsonResponse, withCors } from "./http/response";
import { invalidRequest, notFound } from "./http/errors";
import { handleAdminRequest } from "./routes/admin";
import { handleAccountRequest } from "./routes/account";
import { handleChatCompletions } from "./routes/chat-completions";
import { handleGetFile } from "./routes/files";
import { handleImageGenerations } from "./routes/image-generations";
import { handleAsyncImageGenerations } from "./routes/async-image-generations";
import { handleListModels } from "./routes/models";
import { handleCancelTask, handleCreateTask, handleGetTask, handleListTasks } from "./routes/tasks";
import { processTask } from "./tasks/processor";
import type { Env } from "./types";
import type { AsyncTaskQueueMessage } from "./types";
import { createId } from "./utils/ids";

export default {
  // ── HTTP 请求入口 ──
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = createId("req");

    try {
      if (request.method === "OPTIONS") {
        return emptyResponse({ status: 204 }, request);
      }

      const response = await routeRequest(request, env, requestId);
      return withCors(response, request);
    } catch (error) {
      const errUrl = new URL(request.url);
      console.error(`[${requestId}] ${request.method} ${errUrl.pathname}:`, error);
      return errorResponse(error, requestId, request);
    }
  },

  // ── Queue Consumer 入口 ──
  async queue(batch: MessageBatch<AsyncTaskQueueMessage>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await processTask(env, message.body.task_id);
        message.ack();
      } catch (err) {
        console.error(`[consumer] unhandled error for task ${message.body.task_id}:`, err);
        message.retry();
      }
    }));
  }
};

async function routeRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

  if (request.method === "GET" && pathname === "/") {
    return jsonResponse(
      {
        name: "Teaven AI Gateway",
        version: "0.1.0",
        status: "running",
        endpoints: {
          health: "/health",
          admin: "/admin",
          account: "/account",
          models: "/v1/models",
          chat_completions: "/v1/chat/completions",
          tasks: "/v1/tasks",
          image_generations: "/v1/images/generations"
        }
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  }

  if (request.method === "GET" && pathname === "/health") {
    return jsonResponse(
      {
        status: "ok",
        request_id: requestId
      },
      {
        headers: {
          "X-Request-Id": requestId
        }
      }
    );
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return handleAdminRequest(request, env, requestId, pathname);
  }

  if (pathname === "/account" || pathname.startsWith("/account/")) {
    return handleAccountRequest(request, env, requestId, pathname);
  }

  if (!pathname.startsWith("/v1/")) {
    throw notFound("Endpoint not found");
  }

  const auth = await authenticate(request, env);

  if (request.method === "GET" && pathname === "/v1/models") {
    return handleListModels(request, env, auth, requestId);
  }

  if (request.method === "POST" && pathname === "/v1/chat/completions") {
    return handleChatCompletions(request, env, auth, requestId);
  }

  if (request.method === "POST" && pathname === "/v1/images/generations") {
    return handleImageGenerations(request, env, auth, requestId);
  }

  if (request.method === "POST" && pathname === "/v1/async/images/generations") {
    return handleAsyncImageGenerations(request, env, auth, requestId);
  }

  if (request.method === "POST" && pathname === "/v1/tasks") {
    return handleCreateTask(request, env, auth, requestId);
  }

  const fileMatch = pathname.match(/^\/v1\/files\/(.+)$/);
  if (request.method === "GET" && fileMatch) {
    return handleGetFile(fileMatch[1], env, auth, requestId, request.url);
  }

  if (request.method === "GET" && pathname === "/v1/tasks") {
    return handleListTasks(request, env, auth, requestId);
  }

  const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(cancel))?$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const action = taskMatch[2];

    if (request.method === "GET" && !action) {
      return handleGetTask(taskId, env, auth, requestId, request.url);
    }

    if (request.method === "POST" && action === "cancel") {
      return handleCancelTask(taskId, env, auth, requestId, request.url);
    }

    throw invalidRequest("Method not allowed for task endpoint");
  }

  throw notFound("Endpoint not found");
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}
