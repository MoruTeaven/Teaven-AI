import { invalidRequest } from "./http/errors";
import { clearManagedGatewayConfig, loadManagedGatewayConfig, saveManagedGatewayConfig } from "./admin/store";
import { checkCredentialQuota } from "./admin/credentials-store";
import { createId } from "./utils/ids";
import type {
  CredentialLimit,
  CredentialLimitWindow,
  Env,
  GatewayConfig,
  ModelConfig,
  ModelGroup,
  ModelGroupMember,
  ModelType,
  ProviderRouteConfig,
  UpstreamConfig,
  UpstreamCredential,
  UpstreamModelConfig
} from "./types";

export async function loadGatewayConfig(env: Env): Promise<GatewayConfig> {
  const managedConfig = await loadManagedGatewayConfig(env);
  if (managedConfig) {
    validateGatewayConfig(managedConfig);
    return managedConfig;
  }

  const model = env.OPENAI_COMPATIBLE_DEFAULT_MODEL || "gpt-4o-mini";
  return {
    upstreams: [
      {
        id: createId("up"),
        name: "OpenAI Compatible Default",
        plugin_id: "openai-compatible",
        base_url: env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
        credential_id: "env:OPENAI_COMPATIBLE_API_KEY",
        status: "active",
        models: [
          {
            alias: model,
            provider_model: model,
            modality: "text",
            supports_stream: true,
            priority: 1,
            weight: 100,
            status: "active"
          }
        ]
      }
    ]
  };
}

export async function saveGatewayConfig(env: Env, config: GatewayConfig): Promise<void> {
  validateGatewayConfig(config);
  await saveManagedGatewayConfig(env, config);
}

export async function resetGatewayConfig(env: Env): Promise<void> {
  await clearManagedGatewayConfig(env);
}

export function findModel(config: GatewayConfig, alias: string): ModelConfig | undefined {
  return listModels(config).find((model) => model.alias === alias && model.status !== "disabled");
}

/** 按别名查找模型分组 */
export function findModelGroup(config: GatewayConfig, alias: string): ModelGroup | undefined {
  return config.model_groups?.find((group) => group.alias === alias && group.status !== "disabled");
}

/**
 * 加权随机挑选一个组成员。
 * 仅参与 weight > 0 或未设置 weight 的成员；若全部不可用返回 undefined。
 */
export function pickWeightedMember(members: ModelGroupMember[]): ModelGroupMember | undefined {
  const candidates = members.filter((member) => member.weight === undefined || member.weight > 0);
  if (candidates.length === 0) {
    return undefined;
  }

  const totalWeight = candidates.reduce((sum, member) => sum + (member.weight ?? 1), 0);
  if (totalWeight <= 0) {
    return undefined;
  }

  let remaining = Math.random() * totalWeight;
  for (const member of candidates) {
    remaining -= (member.weight ?? 1);
    if (remaining < 0) {
      return member;
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * 加权随机挑选一个凭证。
 * 仅参与 status 非 disabled 且 weight > 0（或未设置）的凭证；若全部不可用返回 undefined。
 * 注意：本函数只做加权随机，不做配额预检。配额预检由调用方结合 checkCredentialQuota 完成。
 */
export function pickWeightedCredential(credentials: UpstreamCredential[]): UpstreamCredential | undefined {
  const candidates = credentials.filter(
    (cred) => cred.status !== "disabled" && (cred.weight === undefined || cred.weight > 0)
  );
  if (candidates.length === 0) {
    return undefined;
  }

  const totalWeight = candidates.reduce((sum, cred) => sum + (cred.weight ?? 1), 0);
  if (totalWeight <= 0) {
    return undefined;
  }

  let remaining = Math.random() * totalWeight;
  for (const cred of candidates) {
    remaining -= (cred.weight ?? 1);
    if (remaining < 0) {
      return cred;
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * 列出某上游可用凭证池。
 * - 若配置了非空 `credentials` 数组，返回其中 status 非 disabled 的条目。
 * - 否则把 `credential_id` 包装成单条隐式凭证（id 固定为 "default"），保持向后兼容。
 *
 * 返回空数组表示该上游没有可用凭证。
 */
export function listUpstreamCredentials(upstream: UpstreamConfig): UpstreamCredential[] {
  if (Array.isArray(upstream.credentials) && upstream.credentials.length > 0) {
    return upstream.credentials.filter((cred) => cred.status !== "disabled" && cred.credential_id);
  }

  if (upstream.credential_id) {
    return [{ id: "default", credential_id: upstream.credential_id, weight: 1, status: "active" }];
  }

  return [];
}

/** 按路由的 upstream_id 查找上游配置。 */
export function findUpstream(config: GatewayConfig, upstreamId: string): UpstreamConfig | undefined {
  return config.upstreams.find((upstream) => upstream.id === upstreamId);
}

/**
 * 生成凭证的跨上游唯一跟踪引用，用于用量记录、计数器与排错。
 * 形如 "openai-main:cred_abc"。legacy 单凭证场景返回 "{upstream_id}:default"。
 */
export function credentialRef(upstreamId: string, credentialId: string): string {
  return `${upstreamId}:${credentialId}`;
}

export interface PickedCredential {
  credential: UpstreamCredential;
  /** 跨上游唯一的跟踪引用，用于 usage_records / async_tasks / 事件 */
  ref: string;
}

/**
 * 从某上游的凭证池中挑选一个可用凭证：
 * 1. 列出 status 非 disabled 的凭证（含 legacy 单凭证回退）
 * 2. 逐个配额预检，过滤掉超限的
 * 3. 在剩余凭证中按权重加权随机挑选
 *
 * 全部不可用（无凭证或全部超限）时返回 undefined，调用方应跳过该路由并尝试 fallback。
 *
 * 配额预检失败（如 D1 异常）时按"可用"处理，避免因配额表故障阻断所有调用；
 * 真正的配额超限由计数器在调用后继续累加，下一轮自然生效。
 */
export async function pickAvailableCredential(
  env: Env,
  upstream: UpstreamConfig
): Promise<PickedCredential | undefined> {
  const credentials = listUpstreamCredentials(upstream);
  if (credentials.length === 0) {
    return undefined;
  }

  const available: UpstreamCredential[] = [];
  for (const credential of credentials) {
    const ref = credentialRef(upstream.id, credential.id);
    try {
      const check = await checkCredentialQuota(env, ref, credential.limits);
      if (check.allowed) {
        available.push(credential);
      }
    } catch {
      // 配额预检异常时不阻断，视为可用
      available.push(credential);
    }
  }

  if (available.length === 0) {
    return undefined;
  }

  const picked = pickWeightedCredential(available);
  if (!picked) {
    return undefined;
  }

  return {
    credential: picked,
    ref: credentialRef(upstream.id, picked.id)
  };
}

/**
 * 模型别名解析结果。
 * - `requestedAlias`: 用户原始请求的 model 字段
 * - `resolvedAlias`: 实际用于路由的别名（命中组时为成员别名，否则与 requestedAlias 相同）
 * - `group`: 命中的分组（未命中时为 undefined）
 * - `fallbackAlias`: 组配置的回退成员别名（未配置或不可用时为 undefined）
 */
export interface ResolvedModel {
  requestedAlias: string;
  resolvedAlias: string;
  group?: ModelGroup;
  fallbackAlias?: string;
}

/**
 * 解析用户传入的 model 字段。
 * 若命中模型分组，按权重随机挑选一个成员 alias 返回。
 * 若未命中组或组不可用，原样返回 alias。
 */
export function resolveModelAlias(config: GatewayConfig, alias: string): ResolvedModel {
  const group = findModelGroup(config, alias);
  if (!group) {
    return { requestedAlias: alias, resolvedAlias: alias };
  }

  const member = pickWeightedMember(group.members);
  if (!member) {
    // 组内没有可用成员时，回落到 fallback（若配置且 fallback 本身不在已剔除外）
    if (group.fallback_member_alias) {
      return {
        requestedAlias: alias,
        resolvedAlias: group.fallback_member_alias,
        group,
        fallbackAlias: group.fallback_member_alias
      };
    }
    return { requestedAlias: alias, resolvedAlias: alias, group };
  }

  return {
    requestedAlias: alias,
    resolvedAlias: member.alias,
    group,
    fallbackAlias: group.fallback_member_alias
  };
}

export function listModels(config: GatewayConfig): ModelConfig[] {
  const models = new Map<string, ModelConfig>();

  for (const upstream of config.upstreams) {
    if (upstream.status === "disabled") {
      continue;
    }

    for (const upstreamModel of upstream.models) {
      if (upstreamModel.status === "disabled") {
        continue;
      }

      const existing = models.get(upstreamModel.alias);
      const route = toProviderRoute(upstream, upstreamModel);
      if (existing) {
        existing.routes.push(route);
        existing.supports_stream = existing.supports_stream !== false || upstreamModel.supports_stream !== false;
        existing.supports_async = existing.supports_async !== false || upstreamModel.supports_async !== false;
        if (existing.status === "hidden" && upstreamModel.status !== "hidden") {
          existing.status = upstreamModel.status || "active";
        }
      } else {
        models.set(upstreamModel.alias, {
          alias: upstreamModel.alias,
          modality: upstreamModel.modality,
          model_type: upstreamModel.model_type || "ai",
          supports_stream: upstreamModel.supports_stream !== false,
          supports_async: upstreamModel.supports_async !== false,
          image_mode: upstreamModel.image_mode,
          supported_image_sizes: upstreamModel.supported_image_sizes,
          status: upstreamModel.status || "active",
          price: upstreamModel.price,
          price_unit: upstreamModel.price_unit,
          routes: [route]
        });
      }
    }
  }

  return [...models.values()].sort((left, right) => left.alias.localeCompare(right.alias));
}

export function listProviderRoutes(config: GatewayConfig): ProviderRouteConfig[] {
  return listModels(config).flatMap((model) => model.routes);
}

/** 列出所有可用的模型分组（status 非 disabled） */
export function listModelGroups(config: GatewayConfig): ModelGroup[] {
  return (config.model_groups || []).filter((group) => group.status !== "disabled");
}

export function selectRoute(model: ModelConfig, stream = false): ProviderRouteConfig | undefined {
  return model.routes
    .filter((route) => route.status !== "disabled" && (!stream || route.supports_stream !== false))
    .sort((left, right) => (left.priority || 100) - (right.priority || 100))[0];
}

export function validateGatewayConfig(config: GatewayConfig): void {
  if (!config || typeof config !== "object" || !Array.isArray(config.upstreams)) {
    throw new Error("upstreams 必须是数组");
  }

  if (config.upstreams.length === 0) {
    throw new Error("至少需要配置一个 upstream");
  }

  const upstreamIds = new Set<string>();
  const aliases = new Map<string, { modality: string; supports_stream: boolean }>();

  for (const upstream of config.upstreams) {
    if (typeof upstream.id !== "string" || upstream.id.length === 0) {
      throw new Error("upstream id 不能为空");
    }
    if (upstreamIds.has(upstream.id)) {
      throw new Error(`upstream id 重复：${upstream.id}`);
    }
    upstreamIds.add(upstream.id);

    if (typeof upstream.plugin_id !== "string" || upstream.plugin_id.length === 0) {
      throw new Error(`upstream ${upstream.id} 必须配置 plugin_id`);
    }
    if (!Array.isArray(upstream.models)) {
      throw new Error(`upstream ${upstream.id} 必须配置 models 数组`);
    }

    validateUpstreamCredentials(upstream.id, upstream);

    for (const model of upstream.models) {
      if (typeof model.alias !== "string" || model.alias.length === 0) {
        throw new Error(`upstream ${upstream.id} 的 model alias 不能为空`);
      }
      if (typeof model.provider_model !== "string" || model.provider_model.length === 0) {
        throw new Error(`model ${model.alias} 必须配置 provider_model`);
      }
      if (!["text", "image", "video", "file"].includes(model.modality)) {
        throw new Error(`model ${model.alias} 的 modality 无效`);
      }
      if (model.model_type !== undefined && !["ai", "traditional"].includes(model.model_type)) {
        throw new Error(`model ${model.alias} 的 model_type 无效`);
      }

      const existing = aliases.get(model.alias);
      const supportsStream = model.supports_stream !== false;
      if (existing && existing.modality !== model.modality) {
        throw new Error(`model alias ${model.alias} 的 modality 不一致`);
      }
      if (!existing) {
        aliases.set(model.alias, { modality: model.modality, supports_stream: supportsStream });
      }
    }
  }

  validateModelGroups(config, aliases);
}

function validateUpstreamCredentials(upstreamId: string, upstream: UpstreamConfig): void {
  if (!Array.isArray(upstream.credentials) || upstream.credentials.length === 0) {
    return;
  }

  const credIds = new Set<string>();
  for (const cred of upstream.credentials) {
    if (typeof cred.id !== "string" || cred.id.length === 0) {
      throw new Error(`upstream ${upstreamId} 的 credential id 不能为空`);
    }
    if (credIds.has(cred.id)) {
      throw new Error(`upstream ${upstreamId} 的 credential id 重复：${cred.id}`);
    }
    credIds.add(cred.id);

    if (typeof cred.credential_id !== "string" || cred.credential_id.length === 0) {
      throw new Error(`upstream ${upstreamId} 的 credential ${cred.id} 必须配置 credential_id`);
    }

    if (cred.weight !== undefined) {
      if (typeof cred.weight !== "number" || !Number.isFinite(cred.weight) || cred.weight < 0) {
        throw new Error(`upstream ${upstreamId} 的 credential ${cred.id} weight 必须是非负数`);
      }
    }

    if (cred.status !== undefined && !["active", "disabled"].includes(cred.status)) {
      throw new Error(`upstream ${upstreamId} 的 credential ${cred.id} status 无效`);
    }

    validateCredentialLimits(upstreamId, cred.id, cred.limits);
  }
}

function validateCredentialLimits(
  upstreamId: string,
  credentialId: string,
  limits: CredentialLimit[] | undefined
): void {
  if (!limits || limits.length === 0) {
    return;
  }
  if (!Array.isArray(limits)) {
    throw new Error(`upstream ${upstreamId} 的 credential ${credentialId} limits 必须是数组`);
  }

  const validWindows: CredentialLimitWindow[] = ["hour", "day", "week", "month"];
  const seenWindows = new Set<CredentialLimitWindow>();

  for (const limit of limits) {
    if (!validWindows.includes(limit.window)) {
      throw new Error(
        `upstream ${upstreamId} 的 credential ${credentialId} limit window 无效：${String(limit.window)}`
      );
    }
    if (seenWindows.has(limit.window)) {
      throw new Error(
        `upstream ${upstreamId} 的 credential ${credentialId} 重复的 window：${limit.window}`
      );
    }
    seenWindows.add(limit.window);

    const hasMaxRequests = limit.max_requests !== undefined;
    const hasMaxTokens = limit.max_tokens !== undefined;
    if (!hasMaxRequests && !hasMaxTokens) {
      throw new Error(
        `upstream ${upstreamId} 的 credential ${credentialId} limit(${limit.window}) 至少配置 max_requests 或 max_tokens`
      );
    }
    if (hasMaxRequests) {
      if (typeof limit.max_requests !== "number" || !Number.isFinite(limit.max_requests) || limit.max_requests < 0) {
        throw new Error(
          `upstream ${upstreamId} 的 credential ${credentialId} limit(${limit.window}) max_requests 必须是非负数`
        );
      }
    }
    if (hasMaxTokens) {
      if (typeof limit.max_tokens !== "number" || !Number.isFinite(limit.max_tokens) || limit.max_tokens < 0) {
        throw new Error(
          `upstream ${upstreamId} 的 credential ${credentialId} limit(${limit.window}) max_tokens 必须是非负数`
        );
      }
    }
  }
}

function validateModelGroups(
  config: GatewayConfig,
  aliases: Map<string, { modality: string; supports_stream: boolean }>
): void {
  const groups = config.model_groups;
  if (!groups) {
    return;
  }
  if (!Array.isArray(groups)) {
    throw new Error("model_groups 必须是数组");
  }

  const groupAliases = new Set<string>();
  const reservedDefaultAliases = new Set(["tier:advanced", "tier:standard", "tier:basic"]);

  for (const group of groups) {
    if (typeof group.alias !== "string" || group.alias.length === 0) {
      throw new Error("model group alias 不能为空");
    }
    if (groupAliases.has(group.alias)) {
      throw new Error(`model group alias 重复：${group.alias}`);
    }
    groupAliases.add(group.alias);

    if (aliases.has(group.alias)) {
      throw new Error(`model group alias 与已有模型 alias 冲突：${group.alias}`);
    }

    if (!["advanced", "standard", "basic", "custom"].includes(group.level)) {
      throw new Error(`model group ${group.alias} 的 level 无效`);
    }

    if (!["text", "image", "video", "file"].includes(group.modality)) {
      throw new Error(`model group ${group.alias} 的 modality 无效`);
    }

    if (group.status !== undefined && !["active", "disabled"].includes(group.status)) {
      throw new Error(`model group ${group.alias} 的 status 无效`);
    }

    if (!Array.isArray(group.members) || group.members.length === 0) {
      throw new Error(`model group ${group.alias} 必须至少有一个成员`);
    }

    const memberAliases = new Set<string>();
    for (const member of group.members) {
      if (typeof member.alias !== "string" || member.alias.length === 0) {
        throw new Error(`model group ${group.alias} 的 member alias 不能为空`);
      }
      if (memberAliases.has(member.alias)) {
        throw new Error(`model group ${group.alias} 的 member alias 重复：${member.alias}`);
      }
      memberAliases.add(member.alias);

      const memberModel = aliases.get(member.alias);
      if (!memberModel) {
        throw new Error(`model group ${group.alias} 引用了不存在的模型：${member.alias}`);
      }
      if (memberModel.modality !== group.modality) {
        throw new Error(
          `model group ${group.alias} 的 modality(${group.modality}) 与成员 ${member.alias} 的 modality(${memberModel.modality}) 不一致`
        );
      }

      if (member.weight !== undefined) {
        if (typeof member.weight !== "number" || !Number.isFinite(member.weight) || member.weight < 0) {
          throw new Error(`model group ${group.alias} 的 member ${member.alias} weight 必须是非负数`);
        }
      }
    }

    if (group.fallback_member_alias) {
      if (!memberAliases.has(group.fallback_member_alias)) {
        throw new Error(
          `model group ${group.alias} 的 fallback_member_alias ${group.fallback_member_alias} 不在 members 中`
        );
      }
    }
  }

  // 默认三组别名只能各存在一个
  for (const reserved of reservedDefaultAliases) {
    const matches = groups.filter((group) => group.alias === reserved);
    if (matches.length > 1) {
      throw new Error(`默认组别名 ${reserved} 重复`);
    }
  }
}

function toProviderRoute(upstream: UpstreamConfig, model: UpstreamModelConfig): ProviderRouteConfig {
  return {
    upstream_id: upstream.id,
    upstream_name: upstream.name,
    plugin_id: upstream.plugin_id,
    provider_model: model.provider_model,
    credential_id: upstream.credential_id,
    base_url: upstream.base_url,
    config: upstream.config,
    modality: model.modality,
    supports_stream: model.supports_stream !== false,
    supports_async: model.supports_async !== false,
    image_mode: model.image_mode,
    supported_image_sizes: model.supported_image_sizes,
    priority: model.priority,
    weight: model.weight,
    status: model.status || "active"
  };
}
