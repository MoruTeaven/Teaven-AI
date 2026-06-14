import { loadGatewayConfig } from "../config";
import { jsonResponse } from "../http/response";
import type { AuthContext, Env } from "../types";

export async function handleListModels(env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const config = await loadGatewayConfig(env);
  const models = config.models
    .filter((model) => model.status !== "disabled")
    .filter((model) => !auth.allowed_models || auth.allowed_models.includes(model.alias))
    .map((model) => ({
      id: model.alias,
      object: "model",
      owned_by: "teaven"
    }));

  return jsonResponse(
    {
      object: "list",
      data: models
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}
