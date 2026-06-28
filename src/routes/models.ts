import { listModelGroups, listModels, loadGatewayConfig } from "../config";
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
  if (modality && !VALID_MODALITIES.includes(modality)) {
    return jsonResponse(
      { object: "list", data: [] },
      { headers: { "X-Request-Id": requestId } }
    );
  }

  const config = await loadGatewayConfig(env);

  // 真实模型列表
  const models = listModels(config)
    .filter((model) => model.status !== "disabled")
    .filter((model) => !auth.allowed_models || auth.allowed_models.includes(model.alias))
    .filter((model) => !modality || model.modality === modality)
    .map((model) => ({
      id: model.alias,
      object: "model",
      owned_by: "teaven",
      modality: model.modality,
      is_group: false,
      image_mode: model.image_mode || null,
      price: model.price || null,
      price_unit: model.price_unit || null
    }));

  // 模型分组列表（虚拟模型，用户可像普通模型一样调用）
  const groups = listModelGroups(config)
    .filter((group) => !auth.allowed_models || auth.allowed_models.includes(group.alias))
    .filter((group) => !modality || group.modality === modality)
    .map((group) => ({
      id: group.alias,
      object: "model",
      owned_by: "teaven",
      modality: group.modality,
      is_group: true,
      level: group.level,
      name: group.name || null,
      description: group.description || null,
      members_count: group.members.length,
      fallback_member: group.fallback_member_alias || null,
      image_mode: group.modality === "image" ? "both" : null,
      price: null,
      price_unit: null
    }));

  return jsonResponse(
    {
      object: "list",
      data: [...models, ...groups]
    },
    {
      headers: {
        "X-Request-Id": requestId
      }
    }
  );
}
