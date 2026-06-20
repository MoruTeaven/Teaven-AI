import { listModels, loadGatewayConfig } from "../config";
import { jsonResponse } from "../http/response";
import type { AuthContext, Env, Modality } from "../types";

const VALID_MODALITIES: Modality[] = ["text", "image", "video", "file"];

export async function handleListModels(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  const modality = url.searchParams.get("modality") as Modality | null;

  const config = await loadGatewayConfig(env);
  const models = listModels(config)
    .filter((model) => model.status !== "disabled")
    .filter((model) => !auth.allowed_models || auth.allowed_models.includes(model.alias))
    .filter((model) => !modality || model.modality === modality)
    .map((model) => ({
      id: model.alias,
      object: "model",
      owned_by: "teaven",
      modality: model.modality
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
