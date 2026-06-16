import { authenticate } from "./auth/api-key";
import { errorResponse, emptyResponse, jsonResponse, withCors } from "./http/response";
import { invalidRequest, notFound } from "./http/errors";
import { handleAdminRequest } from "./routes/admin";
import { handleAccountRequest } from "./routes/account";
import { handleChatCompletions } from "./routes/chat-completions";
import { handleImageGenerations } from "./routes/image-generations";
import { handleAsyncImageGenerations } from "./routes/async-image-generations";
import { handleListModels } from "./routes/models";
import { handleCancelTask, handleCreateTask, handleGetTask } from "./routes/tasks";
import type { Env } from "./types";
import { createId } from "./utils/ids";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = createId("req");

    try {
      if (request.method === "OPTIONS") {
        return emptyResponse({ status: 204 }, request);
      }

      const response = await routeRequest(request, env, requestId);
      return withCors(response, request);
    } catch (error) {
      return errorResponse(error, requestId, request);
    }
  }
};

async function routeRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

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
    return handleListModels(env, auth, requestId);
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

  const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(cancel))?$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const action = taskMatch[2];

    if (request.method === "GET" && !action) {
      return handleGetTask(taskId, env, auth, requestId);
    }

    if (request.method === "POST" && action === "cancel") {
      return handleCancelTask(taskId, env, auth, requestId);
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
