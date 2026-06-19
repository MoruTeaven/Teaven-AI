# Teaven AI Gateway 技术设计

## 1. 背景

Teaven AI Gateway 是一个多租户 AI API 网关，计划部署在 Cloudflare 平台。它统一封装多个上游模型供应商，对外提供一套稳定的 OpenAI 兼容接口和异步任务接口。

设计重点：

- 文本 LLM 请求直接兼容 OpenAI API，尤其是流式 SSE 协议。
- 图片、视频、文件等非文本能力统一走异步任务，不提供同步长连接流式接口。
- 用户只需要接入本平台，不需要理解每个上游的鉴权、参数、错误码和计费差异。
- 平台内部掌握租户、Key、模型路由、用量、限流、计费和审计。

## 2. 非目标

当前阶段暂不优先实现：

- 自研模型推理。
- 训练、微调、数据集托管等完整 MLOps 能力。
- 对所有 OpenAI API 的完整复制，例如 Assistants、Realtime、Batch 等。
- 图片和视频的同步返回或流式返回。
- 复杂企业级组织架构，例如多级部门、审批流、SSO。

## 3. 产品边界

### 3.1 同步接口

同步接口只用于文本 LLM：

- 聊天补全。
- 文本补全，如后续确有需要。
- Embeddings，如上游和业务需要，可作为非流式同步接口扩展。

文本 LLM 支持：

- OpenAI 兼容请求格式。
- OpenAI 兼容非流式响应。
- OpenAI 兼容 SSE 流式响应。

### 3.2 异步接口

异步接口用于长耗时或文件型任务：

- 图片生成。
- 视频生成。
- 音频或文件处理。
- 其他需要轮询、回调或后台处理的任务。

异步任务统一生命周期：

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`
- `expired`

### 3.3 接口统一原则

平台对外接口与上游真实执行方式解耦。用户只面对 Teaven AI Gateway 的标准接口，上游协议差异全部收敛在 Provider Adapter 和任务执行层。

统一规则：

- 文本 LLM 对外使用 OpenAI 兼容同步接口，并支持流式 SSE。
- 图片、视频、文件等媒体和文件类能力对外只使用异步任务接口。
- 上游同步媒体接口必须被包装成平台异步任务。
- 上游异步媒体接口必须映射到平台异步任务生命周期。
- 上游非标准协议必须转换为平台标准请求、响应、错误和 usage。
- 上游能力差异不直接泄露给用户，除非模型能力本身不可用。

| 能力类型 | 对外接口 | 上游可能形态 | 平台统一方式 |
| --- | --- | --- | --- |
| 文本 LLM | `/v1/chat/completions` | 同步、流式、OpenAI 兼容或类 OpenAI | Adapter 转换为 OpenAI 兼容响应或 SSE chunk。 |
| 图片生成 | `/v1/tasks` | 同步返回、异步任务、非标准接口 | 一律创建平台任务，后台执行并写入标准任务结果。 |
| 视频生成 | `/v1/tasks` | 异步任务、轮询、webhook | 一律映射到平台任务状态和输出文件。 |
| 文件处理 | `/v1/tasks` | 同步、异步、上传后处理 | 通过平台任务状态承载，文件按需转存到 R2。 |

示例：

- 模力方舟生图如果只支持异步，平台创建 `async_tasks` 后保存 `provider_task_id`，由 Queue Worker 或 Cron Worker 查询上游状态。
- 硅基流动生图如果只支持同步，平台仍先返回 `task_id`，由 Queue Worker 调用同步生图接口，成功后把图片写入 R2 并把任务置为 `succeeded`。
- 讯飞星辰如果接口规范不统一，Adapter 负责处理签名、参数命名、响应结构、错误码和状态枚举转换。

## 4. 核心概念

| 概念 | 说明 |
| --- | --- |
| Organization | 组织，计费、配额和数据隔离的顶层单位。 |
| User | 平台登录用户，属于某个组织。 |
| API Key | 用户调用平台 API 的凭证，可绑定权限、模型范围和配额。 |
| Provider Plugin（类型） | 不同插件处理不同上游协议，例如 OpenAI 兼容、硅基流动、模力方舟。 |
| Upstream | 已配置的上游实例，绑定插件（即协议类型）、endpoint、区域、凭证和运行状态。 |
| Provider Credential | 平台访问上游的密钥或凭证引用。 |
| Model Alias | 对外暴露的模型名，例如 `deepseek-chat`。 |
| Upstream Model | 添加到某个上游实例下的模型条目，包含平台别名、上游真实模型名和模型能力，不包含密钥和域名。 |
| Model Route | 运行时从 Upstream Model 归一化得到的路由目标。 |
| Request Log | API 请求记录，用于审计、排障和用量归因。 |
| Usage Record | 标准化后的用量记录，用于计费和配额扣减。 |
| Async Task | 图片、视频、文件等异步任务。 |

## 5. 对外 API

### 5.1 鉴权

所有用户 API 请求使用 Bearer Token：

```http
Authorization: Bearer sk-...
```

平台需要在请求进入业务逻辑前完成：

- API Key 格式校验。
- Key 哈希查询，不明文存储完整 Key。
- Key 状态校验，例如 active、disabled、expired。
- 租户状态校验。
- 权限范围校验，例如允许访问的模型、接口类型、异步任务类型。
- 限流和余额检查。

### 5.2 Chat Completions

接口：

```http
POST /v1/chat/completions
```

请求示例：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "你好" }
  ],
  "temperature": 0.7,
  "stream": true
}
```

非流式响应示例：

```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好，有什么可以帮你？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 8,
    "total_tokens": 20
  }
}
```

流式响应必须使用 OpenAI 兼容 SSE：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

事件示例：

```text
data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","created":1730000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","created":1730000000,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: [DONE]
```

实现要求：

- 对用户保持 OpenAI 兼容事件格式。
- 上游不兼容 OpenAI SSE 时，由 Provider Adapter 转换为统一事件。
- 不在边缘完整缓存流式响应正文。
- 流式完成后异步写入请求日志和用量记录。
- 如果上游在流中返回错误，需要转换为平台统一错误事件或提前终止连接，并记录失败原因。

### 5.3 Models

接口：

```http
GET /v1/models
```

用途：

- 返回当前 API Key 可访问的模型列表。
- 返回对外模型别名，不暴露真实上游模型名和供应商凭证。

响应示例：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-chat",
      "object": "model",
      "owned_by": "teaven"
    }
  ]
}
```

### 5.4 异步任务

创建任务：

```http
POST /v1/tasks
```

请求示例：

```json
{
  "type": "image.generation",
  "model": "image-basic",
  "input": {
    "prompt": "一只猫坐在云端",
    "size": "1024x1024",
    "image_count": 1,
    "steps": 30
  },
  "store_output": true,
  "storage_ttl_seconds": 86400,
  "callback_url": "https://example.com/webhooks/ai-task",
  "metadata": {
    "biz_id": "order_123"
  }
}
```

任务请求参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 必填 | 任务类型，例如 `image.generation`。 |
| `model` | string | 必填 | 对外模型名。 |
| `input` | object | 必填 | 标准化任务输入。 |
| `store_output` | boolean | `false` | 是否把上游输出文件转存到平台 R2。 |
| `storage_ttl_seconds` | integer | `86400` | 平台文件存储时长，仅在发生 R2 存储时生效，最大 86400 秒。 |
| `callback_url` | string | 可选 | 任务完成后的用户 webhook。 |
| `metadata` | object | 可选 | 用户自定义元数据。 |

图片任务 `input` 常用字段：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 必填 | 生图提示词。 |
| `size` | string | `1024x1024` | 图片尺寸。`moark-async` 会解析为上游的 `width` 和 `height`。 |
| `image_count` | integer | `1` | 生成图片数量。兼容旧字段 `n`。 |
| `steps` | integer | `30` | 迭代/采样步数。兼容旧字段 `num_inference_steps`。 |
| `guidance_scale` | number | `1.0` | 提示词引导强度。兼容旧字段 `cfg_scale`。 |
| `negative_prompt` | string | `""` | 反向提示词。当前默认值只适用于 `moark-async` Provider。 |
| `seed` | integer | 可选 | 随机种子，用于结果复现，具体支持范围由上游决定。 |
| `provider_params` | object | 可选 | Provider 原生参数透传区，用于补充平台标准字段尚未覆盖的上游私有参数。 |

不同上游的原生参数名不保证一致。平台任务接口会把 `input` 作为任务输入保存，并由具体 Provider 插件负责映射到上游参数；例如 `moark-async` 会把 `steps` 转为 `num_inference_steps`，把 `guidance_scale` 转为 `cfg_scale`，而 OpenAI 兼容生图接口会把 `image_count` 转为 `n`。面向外部调用方时，应优先使用平台标准字段；没有明确映射的私有参数再放入 `provider_params`。

文件转存规则：

- `store_output` 默认为 `false`，上游返回可访问 URL 时，平台直接返回上游 URL，不写入 R2。
- `store_output` 为 `true` 时，平台下载或接收上游文件，写入 R2，再返回平台受控 URL。
- 上游只返回 base64 或二进制内容时，无论 `store_output` 是否为 `true`，平台都必须强制写入 R2。
- `storage_ttl_seconds` 只控制平台 R2 文件的保留时长，默认 86400 秒，最大 86400 秒。
- 如果未发生 R2 存储，`storage_ttl_seconds` 不生效，平台不承诺上游 URL 的可用时长。
- 所有 R2 业务文件必须写入 `expires_at`，到期后由 R2 生命周期规则或 Cron Worker 删除。

响应示例：

```json
{
  "id": "task_xxx",
  "object": "task",
  "type": "image.generation",
  "status": "queued",
  "created_at": "2026-06-12T00:00:00Z"
}
```

查询任务：

```http
GET /v1/tasks/{task_id}
```

成功响应示例：

```json
{
  "id": "task_xxx",
  "object": "task",
  "type": "image.generation",
  "status": "succeeded",
  "model": "image-basic",
  "output": [
    {
      "type": "image",
      "url": "https://cdn.example.com/files/file_xxx.png",
      "stored": true,
      "source": "r2",
      "expires_at": "2026-06-13T00:00:00Z"
    }
  ],
  "usage": {
    "unit": "image",
    "count": 1
  },
  "diagnostics": {
    "plugin_id": "moark-async",
    "provider_task_id": "upstream_task_xxx",
    "provider_status": "succeeded",
    "poll_count": 8,
    "last_poll_at": "2026-06-12T00:01:10Z",
    "next_poll_at": null,
    "last_error": null
  },
  "events": [
    {
      "at": "2026-06-12T00:00:00Z",
      "stage": "task.created",
      "status": "queued"
    },
    {
      "at": "2026-06-12T00:01:10Z",
      "stage": "poll.result",
      "status": "succeeded",
      "provider_status": "succeeded",
      "attempt": 8
    }
  ],
  "created_at": "2026-06-12T00:00:00Z",
  "completed_at": "2026-06-12T00:01:12Z"
}
```

`events` 是任务状态链，最多保留最近 100 条，用于排查任务是否卡在入队、上游创建、轮询、输出转存或 callback 投递阶段。列表接口可只返回 `diagnostics.last_event` 摘要，单任务查询返回完整 `events`。

未转存输出示例：

```json
{
  "type": "image",
  "url": "https://upstream.example.com/output/image_xxx.png",
  "stored": false,
  "source": "upstream",
  "expires_at": null
}
```

如果 `source` 为 `upstream`，`expires_at` 只在上游明确返回过期时间时填写；否则为 `null`。

取消任务：

```http
POST /v1/tasks/{task_id}/cancel
```

Webhook 投递：

```http
POST {callback_url}
X-Teaven-Signature: t=...,v1=...
```

Webhook body 与任务查询响应保持一致。平台需要对 webhook 投递做重试和死信记录。

异步任务接口必须屏蔽上游执行差异：

- 如果上游是原生异步，平台任务和上游任务建立映射。
- 如果上游是同步接口，平台也不能直接把结果作为创建任务响应返回，而是在后台执行后更新任务。
- 如果上游需要上传文件，平台先把用户文件保存到 R2，再由 Adapter 转换为上游需要的上传方式。
- 如果上游返回文件 URL，默认直接返回上游 URL；只有 `store_output` 为 `true` 时才转存到 R2。
- 如果上游返回 base64 或二进制文件，平台强制转存到 R2，再返回平台受控 URL。
- 如果上游支持 webhook，平台可以接收上游回调，但仍要通过平台任务查询接口和用户 webhook 对外通知。
- 如果上游只支持轮询，平台由后台任务按 `pollPolicy` 查询并更新状态。

## 6. 错误格式

对外错误使用 OpenAI 风格：

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

建议错误码：

| HTTP 状态码 | code | 场景 |
| --- | --- | --- |
| 400 | invalid_request | 参数错误。 |
| 401 | invalid_api_key | Key 缺失或无效。 |
| 403 | permission_denied | Key 无权限访问模型或接口。 |
| 404 | not_found | 资源不存在。 |
| 408 | upstream_timeout | 上游超时。 |
| 409 | task_state_conflict | 任务状态不允许当前操作。 |
| 429 | rate_limit_exceeded | 限流或配额超限。 |
| 500 | internal_error | 平台内部错误。 |
| 502 | upstream_error | 上游返回错误。 |
| 503 | provider_unavailable | 上游不可用或熔断。 |

## 7. 上游插件与适配器

上游接入采用插件化架构。平台核心不直接依赖某个固定供应商，也不在业务流程中写死硅基流动、模力方舟、讯飞星辰等实现。所有供应商都通过 Provider Plugin 暴露同一组标准能力。

一个 Provider Plugin 由以下部分组成：

| 组成 | 说明 |
| --- | --- |
| Plugin Manifest | 插件 ID、名称、版本、能力、配置 schema、可选默认模型建议。 |
| Provider Adapter | 具体协议转换代码。 |
| Credential Schema | 上游密钥、endpoint、区域、签名参数等配置定义。 |
| Capability Schema | 声明支持的能力、执行模式、流式能力、任务交付方式。 |
| Mapping Rules | 状态、错误、usage、文件输出等字段映射规则。 |

插件化目标：

- 新增上游不改变对外 API。
- 新增上游不改变任务状态机、计费格式和错误格式。
- 新增上游只需要实现或复用插件接口、注册插件、配置上游实例，并在上游下添加模型。
- 模型条目只保存平台别名、上游模型名和能力；密钥、域名和协议参数只保存在上游实例上。
- 插件可以是官方内置、项目私有或后续社区贡献。

在 Cloudflare Workers 中，任意第三方代码不建议运行时动态加载。推荐先采用构建期插件注册：插件代码随 Worker 一起构建部署，运行时通过数据库或 KV 启用、禁用和配置。后续如需真正运行时扩展，可增加 Remote Provider Plugin，由平台通过 HTTP 调用外部适配服务。

### 7.1 插件形态

| 形态 | 说明 | 适用场景 |
| --- | --- | --- |
| Built-in Plugin | 随平台代码发布的官方插件。 | OpenAI 兼容、硅基流动、模力方舟等高频供应商。 |
| Private Plugin | 私有部署时加入代码仓库并一起构建。 | 企业自有上游、内部模型服务、定制签名协议。 |
| Remote Plugin | 平台通过 HTTP 调用外部适配服务。 | 不希望重新部署核心 Worker、或需要隔离第三方插件代码。 |

MVP 优先支持 Built-in Plugin 和 Private Plugin。Remote Plugin 可以作为后续扩展，避免早期引入额外网络跳转、鉴权和稳定性风险。

### 7.2 Plugin Manifest

Manifest 示例：

```json
{
  "id": "siliconflow",
  "name": "SiliconFlow",
  "version": "1.0.0",
  "runtime": "in_process",
  "credential_schema": {
    "api_key": { "type": "secret", "required": true },
    "base_url": { "type": "string", "required": false }
  },
  "capabilities": {
    "chat.completions": {
      "execution_mode": "stream_or_sync",
      "supports_stream": true
    },
    "image.generation": {
      "execution_mode": "sync",
      "result_delivery": "direct"
    }
  },
  "default_models": [
    {
      "alias": "deepseek-chat",
      "provider_model": "deepseek-ai/DeepSeek-V3",
      "modality": "text"
    }
  ]
}
```

Manifest 只描述插件能力和配置，不存储密钥明文。密钥应写入 Cloudflare secrets、加密存储或受控 secret 引用。

### 7.3 Adapter 合约

每个 Provider Adapter 负责把平台统一协议转换为上游协议。

Adapter 需要提供：

| 能力 | 说明 |
| --- | --- |
| `capabilities` | 声明支持文本、流式、图片、视频、embedding 等能力和执行模式。 |
| `buildRequest` | 将平台请求转换为上游请求。 |
| `parseResponse` | 将上游非流式响应转换为 OpenAI 兼容响应。 |
| `parseStream` | 将上游流式响应转换为 OpenAI 兼容 SSE chunk。 |
| `mapError` | 将上游错误转换为平台统一错误。 |
| `extractUsage` | 提取 token、图片张数、视频秒数等用量。 |
| `retryPolicy` | 定义可重试错误、最大重试次数和退避策略。 |
| `createTask` | 将平台异步任务输入转换为上游任务创建请求。 |
| `executeSyncTask` | 调用同步型上游接口，并转换为平台任务结果。 |
| `getTask` | 查询异步型上游任务状态。 |
| `cancelTask` | 取消上游任务，如果上游支持。 |
| `normalizeTaskResult` | 将上游图片、视频、文件结果转换为平台标准输出。 |
| `verifyWebhook` | 校验上游回调签名，如果上游支持 webhook。 |
| `healthCheck` | 可选，检查上游凭证、endpoint 或插件状态。 |

Adapter 运行时只接收平台标准对象，例如 `NormalizedChatRequest`、`NormalizedTaskRequest` 和 `ProviderCredential`。Adapter 不应直接访问用户 API Key、租户余额或计费账本。

### 7.4 能力声明

Adapter 的能力声明必须包含执行模式：

```json
{
  "provider": "siliconflow",
  "capabilities": {
    "chat.completions": {
      "execution_mode": "stream_or_sync",
      "supports_stream": true
    },
    "image.generation": {
      "execution_mode": "sync",
      "result_delivery": "direct"
    }
  }
}
```

另一个异步上游示例：

```json
{
  "provider": "modelark",
  "capabilities": {
    "image.generation": {
      "execution_mode": "async_polling",
      "result_delivery": "polling",
      "poll_interval_seconds": 5
    }
  }
}
```

非标准上游也必须适配成同一组平台语义：

| 上游差异 | Adapter 归一方式 |
| --- | --- |
| 鉴权方式不同 | 转换为上游所需 Header、Query、签名或 body 字段。 |
| 参数命名不同 | 从平台标准输入映射到上游字段。 |
| 返回结构不同 | 转换为 OpenAI 兼容响应或平台任务输出。 |
| 状态枚举不同 | 映射为 `queued`、`running`、`succeeded`、`failed`、`canceled`、`expired`。 |
| 错误码不同 | 映射为平台统一错误格式和 HTTP 状态码。 |
| usage 字段缺失 | 使用上游返回、平台估算或模型计价规则生成标准 usage。 |

### 7.5 插件注册与启用

插件注册流程：

1. 插件实现 Adapter 合约。
2. 插件导出 Manifest。
3. 构建时把插件加入 Provider Registry。
4. 部署后在数据库中启用插件。
5. 选择插件配置上游实例，包含 endpoint、区域、凭证引用和协议参数。
6. 在上游实例下添加模型条目，填写平台模型别名和上游真实模型。
7. 可选，执行上游实例 `healthCheck` 验证凭证和网络可用性。

Provider Registry 示例：

```json
{
  "plugins": [
    {
      "id": "openai-compatible",
      "version": "1.0.0",
      "runtime": "in_process",
      "status": "active"
    },
    {
      "id": "xfyun-xingchen",
      "version": "1.0.0",
      "runtime": "in_process",
      "status": "active"
    }
  ]
}
```

Remote Plugin 需要额外配置：

```json
{
  "id": "custom-remote-provider",
  "runtime": "remote_http",
  "endpoint": "https://provider-adapter.example.com",
  "auth_secret_ref": "REMOTE_PROVIDER_SECRET",
  "timeout_ms": 30000
}
```

Remote Plugin 必须遵循同一输入输出协议，并由平台做超时、重试、签名校验和熔断。

上游和模型配置示例：

```json
{
  "upstreams": [
    {
      "id": "siliconflow-cn",
      "name": "SiliconFlow CN",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.siliconflow.cn/v1",
      "credential_id": "cred_siliconflow",
      "status": "active",
      "models": [
        {
          "alias": "deepseek-chat",
          "provider_model": "deepseek-ai/DeepSeek-V3",
          "modality": "text",
          "supports_stream": true,
          "weight": 100,
          "priority": 1
        }
      ]
    },
    {
      "id": "modelark-image",
      "name": "ModelArk image",
      "plugin_id": "modelark",
      "credential_id": "cred_modelark",
      "config": {
        "poll_interval_seconds": 5
      },
      "status": "active",
      "models": [
        {
          "alias": "image-basic",
          "provider_model": "image-generation-v1",
          "modality": "image",
          "supports_stream": false,
          "priority": 1,
          "weight": 100
        }
      ]
    }
  ]
}
```

路由策略：

- 精确匹配外部模型别名。
- 路由目标来自上游模型条目，即所属上游 ID 加 `provider_model`。
- 按租户或 Key 覆盖默认路由。
- 支持权重分流。
- 支持同能力上游失败后的 fallback。
- 流式请求 fallback 只能在响应开始前发生；一旦已向用户发送 SSE chunk，不再切换上游。

## 8. Cloudflare 架构

推荐组件拆分：

| 组件 | 职责 |
| --- | --- |
| API Worker | 对外 HTTP API、鉴权、参数校验、文本转发、SSE 响应。 |
| Provider Layer | 插件注册、上游协议适配、路由、重试、错误映射。 |
| Queue Worker | 消费异步任务、调用上游、写入结果、触发 webhook。 |
| Webhook Worker | 投递用户回调、重试、记录失败。 |
| Cron Worker | 超时补偿、任务巡检、用量汇总、清理过期文件。 |
| D1 | 存储租户、Key、任务、路由、账单汇总等结构化数据。 |
| KV | 缓存模型路由、Key 状态、系统开关等低频配置。 |
| R2 | 存储输入文件、按需转存的输出文件和日志归档。 |
| Queues | 异步任务、webhook 投递、日志后处理。 |
| Durable Objects | 可选，用于强一致限流、并发控制和热点 Key 状态。 |

高吞吐注意事项：

- D1 不适合承载所有高频明细日志写入。MVP 可先写关键请求记录，生产阶段应把高频日志异步写入 R2 或 Analytics Engine，D1 保留账单汇总和可查询索引。
- KV 是最终一致缓存，不能作为强一致扣费账本。
- 流式请求应避免在 Worker 中聚合完整响应，直接使用 `ReadableStream` 转发和转换。
- 异步任务需要幂等处理，避免队列重试导致重复扣费或重复生成。

## 9. 数据模型草案

### 9.1 organizations

| 字段 | 说明 |
| --- | --- |
| id | 组织 ID。 |
| name | 组织名称。 |
| status | active、disabled。 |
| plan | 套餐。 |
| created_at | 创建时间。 |

### 9.2 users

| 字段 | 说明 |
| --- | --- |
| id | 用户 ID。 |
| organization_id | 所属组织。 |
| email | 邮箱。 |
| role | owner、admin、member。 |
| status | active、disabled。 |

### 9.3 api_keys

| 字段 | 说明 |
| --- | --- |
| id | Key ID。 |
| organization_id | 所属组织。 |
| name | Key 名称。 |
| key_hash | Key 哈希。 |
| key_prefix | 展示和排障用前缀。 |
| scopes | 权限范围。 |
| allowed_models | 允许模型列表。 |
| rate_limit | 限流配置。 |
| status | active、disabled、expired。 |
| expires_at | 过期时间。 |

### 9.4 provider_plugins

| 字段 | 说明 |
| --- | --- |
| id | 插件 ID，例如 `openai-compatible`、`siliconflow`。 |
| name | 插件名称。 |
| version | 插件版本。 |
| runtime | in_process、remote_http。 |
| manifest | 插件 Manifest JSON。 |
| status | active、disabled、deprecated。 |
| created_at | 创建时间。 |
| updated_at | 更新时间。 |

### 9.5 upstreams

| 字段 | 说明 |
| --- | --- |
| id | 上游实例 ID，例如 `openai-main`、`siliconflow-cn`。 |
| plugin_id | Provider Plugin ID。不同的插件处理不同的上游协议（如 OpenAI 兼容、异步轮询、webhook 等）。 |
| name | 管理后台展示名。 |
| base_url | 上游 API Base URL。 |
| credential_id | 使用的上游凭证。 |
| config | 非密钥配置 JSON，例如 region、api_version、poll_interval_seconds。 |
| capabilities | 该上游实例实际启用的能力。 |
| status | active、disabled、degraded。 |
| created_at | 创建时间。 |
| updated_at | 更新时间。 |

### 9.6 provider_credentials

| 字段 | 说明 |
| --- | --- |
| id | 凭证 ID。 |
| name | 凭证名称。 |
| secret_ref | Cloudflare secret 或加密引用。 |
| status | active、disabled。 |

### 9.7 model_aliases

| 字段 | 说明 |
| --- | --- |
| id | 模型别名 ID。 |
| alias | 对外模型名。 |
| modality | text、image、video、file。 |
| supports_stream | 是否支持流式。 |
| status | active、hidden、disabled。 |

### 9.8 upstream_models

| 字段 | 说明 |
| --- | --- |
| id | 上游模型条目 ID。 |
| alias_id | 模型别名 ID。 |
| organization_id | 可选，组织级覆盖。 |
| upstream_id | 上游实例 ID。 |
| provider_model | 上游真实模型名。 |
| modality | text、image、video、file。 |
| supports_stream | 是否支持流式。 |
| priority | 优先级。 |
| weight | 权重。 |
| status | active、disabled。 |

管理后台添加模型时创建的是 `upstream_models` 记录。该记录不保存密钥、域名或协议参数，这些信息全部从 `upstreams` 读取。

### 9.9 request_logs

| 字段 | 说明 |
| --- | --- |
| id | 请求 ID。 |
| organization_id | 组织 ID。 |
| api_key_id | API Key ID。 |
| endpoint | 请求路径。 |
| model | 对外模型名。 |
| upstream_id | 实际上游实例。 |
| plugin_id | Provider Plugin ID。 |
| provider_model | 实际上游模型。 |
| status_code | 响应状态码。 |
| latency_ms | 总耗时。 |
| stream | 是否流式。 |
| error_code | 错误码。 |
| created_at | 创建时间。 |

### 9.10 usage_records

| 字段 | 说明 |
| --- | --- |
| id | 用量记录 ID。 |
| request_id | 请求 ID 或任务 ID。 |
| organization_id | 组织 ID。 |
| model | 对外模型名。 |
| upstream_id | 实际上游实例。 |
| plugin_id | Provider Plugin ID。 |
| prompt_tokens | 输入 token。 |
| completion_tokens | 输出 token。 |
| total_tokens | 总 token。 |
| media_unit | 图片、视频等计量单位。 |
| media_count | 媒体数量或秒数。 |
| cost | 成本或计费金额。 |
| created_at | 创建时间。 |

### 9.11 async_tasks

| 字段 | 说明 |
| --- | --- |
| id | 任务 ID。 |
| organization_id | 组织 ID。 |
| api_key_id | API Key ID。 |
| type | 任务类型。 |
| model | 对外模型名。 |
| upstream_id | 实际上游实例。 |
| plugin_id | Provider Plugin ID。 |
| provider_execution_mode | 上游执行模式，例如 sync、async_polling、async_webhook。 |
| provider_task_id | 上游任务 ID。 |
| provider_context | 上游任务上下文 JSON，例如轮询地址、上传凭证、回调关联信息。 |
| status | queued、running、succeeded、failed、canceled、expired。 |
| input | 标准化输入 JSON。 |
| output | 标准化输出 JSON。 |
| store_output | 是否转存输出文件。 |
| storage_ttl_seconds | 文件存储时长，默认 86400，最大 86400。 |
| output_expires_at | 平台托管文件的过期时间。 |
| callback_url | 回调地址。 |
| error | 错误信息。 |
| events | 任务状态链 JSON，记录创建、入队、上游创建、轮询、输出转存和 callback 投递等事件。 |
| idempotency_key | 幂等键。 |
| next_poll_at | 下次轮询时间。 |
| created_at | 创建时间。 |
| updated_at | 更新时间。 |
| completed_at | 完成时间。 |

## 10. 关键流程

### 10.1 文本流式请求

1. 用户请求 `POST /v1/chat/completions`，设置 `stream: true`。
2. API Worker 校验 API Key、租户状态、模型权限、余额和限流。
3. 根据模型别名选择上游路由。
4. Provider Adapter 构造上游请求。
5. API Worker 发起上游请求。
6. 如果上游响应头已成功，向用户返回 SSE 响应。
7. Provider Adapter 边读边转换 chunk。
8. 用户收到 OpenAI 兼容 `chat.completion.chunk`。
9. 流结束后发送 `data: [DONE]`。
10. 异步记录请求日志和用量。

### 10.2 文本非流式请求

1. 用户请求 `POST /v1/chat/completions`，不设置 `stream` 或设置为 `false`。
2. API Worker 完成鉴权、限流、路由。
3. 调用上游并等待完整响应。
4. Provider Adapter 转换为 OpenAI 兼容响应。
5. 写入请求日志和用量。
6. 返回用户。

### 10.3 异步媒体任务

1. 用户请求 `POST /v1/tasks`。
2. API Worker 校验 Key、权限、输入参数和幂等键。
3. 写入 `async_tasks`，状态为 `queued`。
4. 消息投递到 Cloudflare Queue。
5. Queue Worker 拉取任务，将状态改为 `running`。
6. Provider Adapter 创建或执行上游任务。
7. 对需要轮询的上游，Queue Worker 或 Cron Worker 周期检查状态。
8. 成功后按文件转存规则处理输出，更新任务为 `succeeded`。
9. 失败则记录标准化错误并更新为 `failed`。
10. 如用户传入 `callback_url`，投递 webhook。

### 10.4 上游同步任务接入

适用于硅基流动生图等上游同步返回结果的接口。

1. 用户请求 `POST /v1/tasks`。
2. API Worker 创建平台任务，状态为 `queued`，立即返回 `task_id`。
3. Queue Worker 消费任务，将状态改为 `running`。
4. Provider Adapter 调用上游同步接口。
5. 上游同步返回图片、视频或文件结果。
6. 平台按 `store_output` 和上游返回形态决定直接返回上游 URL，或写入 R2。
7. Adapter 转换为平台标准 `output` 和 `usage`。
8. 平台将任务状态改为 `succeeded`。
9. 如同步上游调用失败，平台将任务状态改为 `failed`，并记录标准化错误。
10. 如配置了用户 webhook，投递最终任务状态。

这类流程中，用户不感知上游是同步接口。创建任务响应不能直接返回最终媒体结果，避免同一种平台能力在不同供应商下表现不一致。

### 10.5 上游异步任务接入

适用于模力方舟生图、视频生成等上游原生异步接口。

1. 用户请求 `POST /v1/tasks`。
2. API Worker 创建平台任务，状态为 `queued`。
3. Queue Worker 消费任务，将状态改为 `running`。
4. Provider Adapter 调用上游创建任务接口。
5. 平台保存 `provider_task_id` 和必要的上游上下文。
6. 如果上游支持 webhook，平台保存回调关联信息，并在收到上游回调时校验签名。
7. 如果上游只支持轮询，Cron Worker 或 Queue Worker 按 `pollPolicy` 查询状态。
8. 上游完成后，Adapter 转换上游输出。
9. 平台按文件转存规则处理结果文件，并更新任务为 `succeeded`。
10. 上游失败、取消或超时时，平台映射为对应任务状态和错误。

平台任务状态不应直接等同于上游状态。上游状态必须经过 Adapter 映射，保证所有供应商对外表现一致。

### 10.6 非标准协议接入

适用于讯飞星辰等请求格式、鉴权方式、状态字段或响应结构不统一的供应商。

1. 平台内部先构造标准 `NormalizedRequest`。
2. Provider Adapter 将标准请求转换为上游私有协议。
3. Adapter 处理上游签名、鉴权、特殊 Header、Query 和 body。
4. 上游返回后，Adapter 将私有响应转换为平台标准响应。
5. 上游错误必须通过 `mapError` 转换为平台错误格式。
6. 上游 usage 或计费字段必须通过 `extractUsage` 转换为平台 usage。
7. 如果上游不返回必要字段，Adapter 需要显式标记估算值或不可用字段。

非标准协议不能扩散到业务层。API Worker、任务系统、计费系统只处理平台标准对象。

## 11. 限流、配额和计费

限流维度：

- 租户级 QPS。
- API Key 级 QPS。
- 模型级并发。
- 流式连接并发。
- 异步任务排队数量。
- 每日或每月 token、金额、任务数配额。

计费记录原则：

- 使用平台统一单位记录，不直接暴露上游原始计费格式。
- 文本记录 prompt tokens、completion tokens、total tokens。
- 图片记录张数、尺寸、模型倍率。
- 视频记录秒数、分辨率、模型倍率。
- 异步任务需要明确扣费时机，建议成功后扣费；如果上游失败但已产生费用，需要记录为平台成本，不一定向用户计费。
- 流式请求如果中途断开，需要记录已知 token；若上游不返回 usage，则使用 tokenizer 或估算策略，标记为 estimated。

## 12. 安全设计

- API Key 只在创建时展示完整值，数据库只保存哈希和前缀。
- 上游密钥使用 Cloudflare secrets 或加密存储，不写入代码和普通日志。
- In-process Provider Plugin 视为可信代码，必须经过代码审查后随 Worker 构建部署。
- Remote Provider Plugin 视为不可信外部服务，平台调用时必须使用签名、超时、重试上限和熔断。
- 插件只能接收当前请求所需的最小凭证和标准化请求上下文，不能访问用户 API Key 明文、租户余额或完整账本。
- 请求日志默认不保存完整 prompt 和 completion；如需要调试采样，必须受租户开关和脱敏策略控制。
- R2 业务文件使用短期签名 URL 或受控下载接口，默认最多保存 24 小时，到期删除。
- Webhook 使用签名头，用户可校验来源。
- 管理后台操作需要审计日志。
- 对外错误不得泄露上游密钥、内部路由和堆栈信息。

## 13. 可观测性

需要记录的指标：

- 请求量、成功率、错误率。
- 上游维度延迟和错误率。
- 首 token 延迟。
- 流式平均持续时间。
- 队列积压长度。
- 异步任务成功率、失败率、平均耗时。
- webhook 投递成功率。
- 每租户、每模型用量和成本。

日志建议：

- 每个请求生成 `request_id`。
- 向上游传递 `request_id`，便于排障。
- 对外响应头返回 `X-Request-Id`。
- 流式请求至少记录开始、结束、上游、耗时、状态和 usage。

## 14. 配置管理

插件、上游实例和上游模型配置建议支持热更新。新增上游时，先注册或启用 Provider Plugin，再配置上游实例，最后在上游实例下添加模型。

```json
{
  "provider_plugins": [
    {
      "id": "openai-compatible",
      "version": "1.0.0",
      "runtime": "in_process",
      "status": "active"
    }
  ],
  "upstreams": [
    {
      "id": "siliconflow-cn",
      "name": "SiliconFlow CN",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.siliconflow.cn/v1",
      "credential_id": "cred_xxx",
      "status": "active",
      "models": [
        {
          "alias": "deepseek-chat",
          "provider_model": "deepseek-ai/DeepSeek-V3",
          "modality": "text",
          "supports_stream": true,
          "priority": 1,
          "weight": 100
        }
      ]
    }
  ]
}
```

配置来源优先级：

1. 租户级上游和上游模型覆盖。
2. 全局数据库插件、凭证、上游和上游模型配置。
3. KV 缓存配置。
4. 构建期 Provider Registry。
5. 代码内默认配置。

新增上游流程：

1. 确认上游协议，优先复用已有 Provider Plugin。
2. 如协议未覆盖，实现或引入 Provider Plugin。
3. 注册 Manifest 到 Provider Registry。
4. 部署 Worker 或配置 Remote Plugin endpoint。
5. 在管理侧启用插件。
6. 配置 Provider Credential。
7. 配置上游实例，绑定 `plugin_id`（即协议类型）、endpoint、协议参数和凭证。
8. 在上游实例下添加模型条目，填写 `alias + provider_model` 和模型能力。
9. 执行健康检查和测试调用。

## 15. 兼容性策略

OpenAI 兼容优先级：

- 高优先级：`/v1/chat/completions`、SSE chunk、错误格式、`/v1/models`。
- 中优先级：常见参数透传，例如 `temperature`、`top_p`、`max_tokens`、`stop`、`presence_penalty`、`frequency_penalty`。
- 按需支持：`tools`、`tool_choice`、`response_format`、`seed`、`logprobs`。
- 不支持参数必须明确返回错误，不能静默忽略会影响结果的关键参数。

## 16. MVP 里程碑

### M1：基础文本网关

- Worker 项目骨架。
- API Key 鉴权。
- `POST /v1/chat/completions`。
- Provider Plugin 基础接口。
- OpenAI 兼容 Provider Plugin。
- SSE 流式转发。
- 基础错误归一。

### M2：插件注册与上游模型

- Provider Registry。
- 插件启用、禁用和版本记录。
- 至少接入一个非 OpenAI 兼容的示例插件。
- 上游实例、上游模型表和运行时路由归一化。
- fallback 和简单权重分流。
- `/v1/models`。

### M3：多租户和用量

- 租户、用户、API Key 管理。
- 请求日志。
- Usage 记录。
- 配额和限流。

### M4：异步任务

- `POST /v1/tasks`。
- `GET /v1/tasks/{task_id}`。
- Queue Worker。
- 文件按需转存到 R2，并支持过期清理。
- Webhook 投递。

### M5：生产化

- 管理后台。
- 账单汇总。
- 监控告警。
- 灰度发布。
- 路由配置热更新。

## 17. 待确认问题

- 项目是否需要兼容 NewAPI 的管理后台概念，还是只提供 API 和内部管理能力？
- 首批官方内置 Provider Plugin 和模型清单是什么？
- 是否需要在 MVP 支持 Remote Provider Plugin，还是先只支持构建期插件？
- 是否需要对外提供充值、余额和账单页面？
- 是否需要用户自带上游 Key，还是平台统一托管上游 Key？
- 是否要支持 OpenAI `tools` 和函数调用作为 MVP 必选能力？
- 异步媒体任务的首个落地方向是图片、视频，还是文件解析？
- 是否需要国内用户访问优化和自定义域名策略？
