# 配置说明

本文档说明项目当前识别的环境变量、Cloudflare 绑定，以及当前采用的"插件 -> 上游 -> 模型"配置分层。

## 配置文件

| 文件 | 用途 | 是否提交真实值 |
| --- | --- | --- |
| `wrangler.toml` | Worker 基础配置和非敏感 `[vars]`。 | 可以提交非敏感默认值。 |
| `.dev.vars` | 本地 `wrangler dev` 使用的环境变量。 | 不提交真实密钥。 |
| `.dev.vars.example` | 本地环境变量模板。 | 只提交占位值。 |

密钥不要写进 `wrangler.toml`。本地开发放在 `.dev.vars`，线上部署建议用 Cloudflare Worker Secret。

## 本地最小配置

如果只想本地跑通默认 OpenAI 兼容聊天接口，`.dev.vars` 最少需要：

```bash
ADMIN_TOKEN=admin-dev-only-change-me
DEV_API_KEY=dev-only-change-me
OPENAI_COMPATIBLE_API_KEY=sk-replace-me
```

`OPENAI_COMPATIBLE_BASE_URL` 和 `OPENAI_COMPATIBLE_DEFAULT_MODEL` 在当前默认值不变时可以不配，因为代码里已有 fallback。

## 环境变量

| 变量 | 当前作用 | 是否必需 | 默认值 |
| --- | --- | --- | --- |
| `ADMIN_TOKEN` | 管理后台 `/admin` 的登录密码，也用于签发后台会话 Cookie。 | 访问后台必需 | 无 |
| `DEV_API_KEY` | `/v1/*` 用户接口的 Bearer Token。 | 默认鉴权模式下必需 | 无 |
| `AUTH_MODE` | 认证模式。设置为 `none` 时跳过 `/v1/*` API Key 校验。 | 可选 | `api_key` 行为 |
| `OPENAI_COMPATIBLE_API_KEY` | 当前 MVP 默认 OpenAI 兼容上游的 API Key。 | 调用默认聊天补全必需 | 无 |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI 兼容上游的 API Base URL。请求会发到 `${BASE_URL}/chat/completions`。 | 可选 | `https://api.openai.com/v1` |
| `OPENAI_COMPATIBLE_DEFAULT_MODEL` | 未配置 `MODEL_CONFIG_JSON` 时生成默认模型别名和上游模型名。 | 可选 | `gpt-4o-mini` |
| `FILES_PUBLIC_BASE_URL` | R2 文件公开访问域名或路径前缀，用于把任务 `output[].url` 中的 R2 key 组装成完整 URL。未配置时任务查询接口使用当前 Worker 域名生成 `/v1/files/...` 受控下载 URL。 | 可选 | 当前请求域名 + `/v1/files/` |
| `MODEL_CONFIG_JSON` | 覆盖默认上游实例和上游模型配置。 | 可选 | 自动生成一个默认上游和默认模型 |

## 配置分层

配置顺序应该是先配置插件和上游，再在上游下添加模型：

1. 选择 Provider Plugin，每个插件对应一种上游协议类型（如 OpenAI 兼容、异步轮询任务、异步 webhook 任务、私有协议）。
2. 配置上游实例，把插件、endpoint、区域、凭证和健康检查状态绑定到一个稳定的上游 ID。
3. 在上游实例下添加模型条目，只填写平台模型别名、上游真实模型名和模型能力。

这样可以把"怎么调用某类上游"和"这次实际调用哪个模型"拆开。同一个 OpenAI 兼容协议插件可以配置多个上游，例如 OpenAI 官方、硅基流动兼容接口、私有 vLLM 网关；同一个上游也可以承载多个平台模型别名。模型添加时不再单独填写密钥、域名或 base URL，这些只属于上游实例。

| 层级 | 保存内容 | 示例 | 用户是否可见 |
| --- | --- | --- | --- |
| 插件 | 协议转换、流式解析、任务状态映射、错误归一。 | `openai-compatible`、`modelark` | 否 |
| 上游实例 | 插件、base URL、凭证引用、区域、协议参数、状态。 | `openai-main`、`siliconflow-cn` | 否 |
| 上游模型 | 对外模型名、上游真实模型名、能力、优先级和权重，不含密钥和域名。 | `fast-chat` -> `Qwen/Qwen2.5-72B-Instruct` | 别名可见 |

配置示例：

```json
{
  "upstreams": [
    {
      "id": "openai-main",
      "name": "OpenAI official",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "credential_id": "env:OPENAI_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "gpt-4o-mini",
          "provider_model": "gpt-4o-mini",
          "modality": "text",
          "supports_stream": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    },
    {
      "id": "siliconflow-cn",
      "name": "SiliconFlow CN",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.siliconflow.cn/v1",
      "credential_id": "env:SILICONFLOW_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "fast-chat",
          "provider_model": "Qwen/Qwen2.5-72B-Instruct",
          "modality": "text",
          "supports_stream": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    },
    {
      "id": "internal-llm",
      "name": "Internal LLM",
      "plugin_id": "internal-llm",
      "base_url": "https://llm.internal.example",
      "credential_id": "env:INTERNAL_LLM_TOKEN",
      "config": {
        "signing": "hmac-v1"
      },
      "status": "active",
      "models": [
        {
          "alias": "private-chat",
          "provider_model": "chat-prod",
          "modality": "text",
          "supports_stream": false,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

当前代码使用 `GatewayConfig.upstreams[]` 作为配置入口。运行时会把 `upstreams[].models[]` 归一化为可查询的模型路由，用于 `/v1/models`、聊天补全转发、后台健康检查和用量记录。

## OpenAI 兼容配置

`openai-compatible` 是当前内置的 Provider Plugin，用来代理所有兼容 OpenAI `chat/completions` 协议的上游。

请求流程如下：

1. 用户请求 `POST /v1/chat/completions`，请求体里的 `model` 是平台模型别名。
2. 网关读取 `MODEL_CONFIG_JSON`。如果没有配置，则用 `OPENAI_COMPATIBLE_DEFAULT_MODEL` 自动生成一个默认上游和默认模型。
3. 网关在 `upstreams[].models[]` 中按模型别名找到上游模型条目，选择优先级最小的 active 条目。
4. 网关从所属上游实例读取 `plugin_id`、`base_url`、`credential_id` 和协议参数。
5. 网关把请求转发到上游 `base_url + /chat/completions`，并把请求体里的 `model` 改成上游模型条目的 `provider_model`。

默认情况下，不配置 `MODEL_CONFIG_JSON` 时等价于下面这份配置：

```json
{
  "upstreams": [
    {
      "id": "openai-compatible-default",
      "name": "OpenAI Compatible Default",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "credential_id": "env:OPENAI_COMPATIBLE_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "gpt-4o-mini",
          "provider_model": "gpt-4o-mini",
          "modality": "text",
          "supports_stream": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

因此，当前 `wrangler.toml` 里的这两项只是显式写出了代码默认值：

```toml
[vars]
OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1"
OPENAI_COMPATIBLE_DEFAULT_MODEL = "gpt-4o-mini"
```

如果你只用 OpenAI 官方接口，并且默认模型就是 `gpt-4o-mini`，这两项可以删掉，不影响当前默认行为。

## 什么时候需要改这些变量

| 场景 | 应该改什么 |
| --- | --- |
| 只接 OpenAI 官方接口 | 只配置 `OPENAI_COMPATIBLE_API_KEY` 即可。 |
| 改默认模型 | 设置 `OPENAI_COMPATIBLE_DEFAULT_MODEL`，例如 `gpt-4.1-mini`。 |
| 接其他 OpenAI 兼容服务 | 设置 `OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_DEFAULT_MODEL` 和对应 API Key。 |
| 暴露多个模型别名 | 配置 `MODEL_CONFIG_JSON`，在对应上游的 `models[]` 下添加模型条目。 |
| 不想在本地传 Bearer Token | 设置 `AUTH_MODE=none`。不要在线上使用。 |

## MODEL_CONFIG_JSON

`MODEL_CONFIG_JSON` 当前用于替代自动生成的默认上游和模型配置。它适合配置多个插件、多个上游、多个模型别名或不同上游模型名。

字段含义：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `upstreams` | 根对象 | 上游实例数组。 |
| `id` | upstream | 上游实例 ID，例如 `openai-main`。 |
| `name` | upstream | 管理后台展示名。 |
| `plugin_id` | upstream | Provider Plugin ID。不同的插件处理不同的上游协议（如 OpenAI 兼容、异步轮询、webhook 等）。 |
| `base_url` | upstream | 上游 API Base URL。 |
| `credential_id` | upstream | 上游凭证位置或凭证记录 ID（默认凭证，凭证池为空时使用）。 |
| `credentials` | upstream | 多凭证池数组（可选）。配置后调用时按权重随机挑选可用 key，超额自动跳过。详见下方「多凭证池与配额上限」章节。 |
| `config` | upstream | 协议相关的非密钥配置，例如 region、api_version、poll_interval_seconds。 |
| `models` | upstream | 添加到该上游实例下的模型条目数组。 |
| `alias` | upstream model | 对用户暴露的模型名。 |
| `provider_model` | upstream model | 上游真实模型名。 |
| `modality` | upstream model | 模型类型。 |
| `supports_stream` | upstream model | 是否允许 `stream: true`。 |
| `priority` | upstream model | 同一别名跨多个上游时的优先级。 |
| `weight` | upstream model | 同一优先级下的权重。 |
| `status` | upstream/upstream model | `disabled` 会禁用上游或模型条目。未设置视为 active。 |

示例：对外暴露 `fast-chat`，实际调用上游 `gpt-4o-mini`：

```json
{
  "upstreams": [
    {
      "id": "openai-main",
      "name": "OpenAI official",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "credential_id": "env:OPENAI_COMPATIBLE_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "fast-chat",
          "provider_model": "gpt-4o-mini",
          "modality": "text",
          "supports_stream": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

配置后，用户请求时应使用平台别名：

```json
{
  "model": "fast-chat",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

### 多凭证池与配额上限

`MODEL_CONFIG_JSON` 的 upstream 还支持 `credentials` 字段，可为同一个上游配置多个 API key。配置后：

- 调用时按 `weight` 加权随机挑选一个 `status: "active"` 的凭证
- 每次调用前先检查该凭证在当前窗口的累计用量是否超额，超额则跳过该凭证
- 若所有凭证都超额或不可用，请求失败并返回 `No available credential`
- 凭证池为空（未配置 `credentials`）时回退到上游的默认 `credential_id`，保持向后兼容

`credential_ref` 字段（格式为 `<upstream_id>:<credential.id>`）会写入用量记录和异步任务事件，便于通过 `request_id` / `task_id` 反查实际使用的 key。**注意**：`credential_ref` 只包含 tracking ID，不包含真实密钥，可安全出现在日志中。

#### 凭证字段

| 字段 | 含义 |
| --- | --- |
| `id` | 凭证跟踪 ID（非密钥），用于 `credential_ref` 拼接和日志定位。同一 upstream 内不能重复。缺失时自动按索引生成 `key1` / `key2` ... |
| `label` | 备注名（可选），例如「主账号」「免费额度」。仅用于管理后台展示。 |
| `credential_id` | 真实凭证引用，与 upstream 的 `credential_id` 字段格式一致：`env:SECRET_NAME` 或直接填 `sk-...`。 |
| `weight` | 加权随机的权重，默认 1。设为 0 或负数等价于不参与抽取。 |
| `status` | `active` / `disabled`，未设置视为 active。 |
| `limits` | 配额上限数组（可选）。每个元素描述一个时间窗口的请求数或 Token 数上限。 |

#### 配额上限字段

每个 `limits[]` 元素支持以下字段：

| 字段 | 含义 |
| --- | --- |
| `window` | 时间窗口类型：`hour`（整点重置）/ `day`（每日 00:00 重置）/ `week`（ISO 周一 00:00 重置）/ `month`（每月 1 日 00:00 重置）。同一凭证内同窗口不能重复。 |
| `max_requests` | 该窗口内最大请求数（可选，非负整数）。 |
| `max_tokens` | 该窗口内最大 Token 数（可选，非负整数）。 |

`max_requests` 和 `max_tokens` 至少配置一个。配额计数使用固定窗口算法（非滑动窗口）：

- `hour`：按整点重置（例如 14:23 的请求计入 `14` 窗口，15:00 后归零）
- `day` / `week` / `month`：按本地服务器时间（UTC）的日 / ISO 周 / 月边界重置

配额计数存储在 D1 的 `credential_usage_counters` 表（PK: `credential_ref + window_type + window_key`），每次调用 O(1) 累加。配额检查失败（如 D1 不可用）不会阻断请求，凭证会被当作「可用」处理，避免计量基础设施故障引发服务中断。

#### 配置示例

为 OpenAI 上游配置 3 个 key：主账号高权重无限制、备用账号低权重日限 1000 次、免费额度账号小时限 100 次：

```json
{
  "upstreams": [
    {
      "id": "openai-main",
      "name": "OpenAI 多账号池",
      "plugin_id": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "credential_id": "env:OPENAI_COMPATIBLE_API_KEY",
      "credentials": [
        {
          "id": "primary",
          "label": "主账号（无限额）",
          "credential_id": "env:OPENAI_PRIMARY_KEY",
          "weight": 10,
          "status": "active"
        },
        {
          "id": "backup",
          "label": "备用账号（日限 1000 次）",
          "credential_id": "env:OPENAI_BACKUP_KEY",
          "weight": 3,
          "limits": [
            { "window": "day", "max_requests": 1000 }
          ]
        },
        {
          "id": "free",
          "label": "免费额度（小时 100 次 + 月 5 万 Token）",
          "credential_id": "env:OPENAI_FREE_KEY",
          "weight": 1,
          "limits": [
            { "window": "hour", "max_requests": 100 },
            { "window": "month", "max_tokens": 50000 }
          ]
        }
      ],
      "models": [
        {
          "alias": "fast-chat",
          "provider_model": "gpt-4o-mini",
          "modality": "text",
          "status": "active"
        }
      ]
    }
  ]
}
```

#### 调用链中的 credential_ref 排错

每次请求实际命中某个凭证后，`credential_ref` 会出现在以下位置：

1. **`usage_records.credential_ref`**：通过 `request_id` 关联到具体凭证
2. **`async_tasks.credential_ref`**：异步任务记录顶层字段
3. **`async_tasks.provider_context.credential_ref`**：consumer 轮询时复用同一个 key
4. **任务事件 `task.created` / `poll.started` / `upstream.create.started`** 的 `credential_ref` 字段：可在 `GET /v1/tasks/:id` 返回的 events 数组中查看

排错示例：用户反馈某次请求 5xx，从请求日志拿到 `request_id` 后，在管理后台「用量」Tab 或 D1 中查询 `SELECT * FROM usage_records WHERE request_id = ?`，即可看到 `credential_ref` 字段，定位到具体哪个 key 出问题。

### 模型分组（model_groups）

`MODEL_CONFIG_JSON` 还支持 `model_groups` 字段，把多个同模态的模型别名组合成一个对外别名。用户调用时填组别名，平台按权重随机挑选一个成员执行；成员调用失败（5xx / 429 / 网络错误）时自动回退到 `fallback_member_alias`。

响应里的 `model` 字段返回组别名；但 `usage_records.model` / `async_tasks.model` 字段记录实际命中的成员别名，并通过 `requested_model` 字段保留组别名，便于通过 `request_id` 反查。

| 字段 | 含义 |
| --- | --- |
| `alias` | 用户调用时填写的组别名，不可与已有模型别名冲突。 |
| `name` | 显示名（可选）。 |
| `level` | 分组级别：`advanced` / `standard` / `basic` / `custom`。 |
| `modality` | 组模态，所有成员必须同模态。 |
| `status` | `active` / `disabled`，未设置视为 active。 |
| `description` | 分组说明（可选）。 |
| `fallback_member_alias` | 失败回退成员别名，必须存在于 `members` 中（可选）。 |
| `members` | 成员数组，每个成员含 `alias`（必须已存在）和 `weight`（默认 1，>0 才参与抽取）。 |

默认三组别名 `tier:advanced` / `tier:standard` / `tier:basic` 各只能存在一个；也支持任意自定义组别名。推荐通过管理后台「模型分组」Tab 可视化维护，或调用 `/admin/api/model-groups` 系列接口管理。

```json
{
  "upstreams": [ /* ... */ ],
  "model_groups": [
    {
      "alias": "tier:advanced",
      "name": "高级模型组",
      "level": "advanced",
      "modality": "text",
      "status": "active",
      "fallback_member_alias": "fast-chat",
      "members": [
        { "alias": "fast-chat", "weight": 3 },
        { "alias": "deep-chat", "weight": 1 }
      ]
    }
  ]
}
```

调用示例（model 字段填组别名）：

```json
{
  "model": "tier:advanced",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

## Cloudflare 绑定

这些不是普通 `[vars]`，而是 Cloudflare Worker 绑定。当前代码会识别以下绑定名称：

| 绑定 | 当前作用 |
| --- | --- |
| `AI_GATEWAY_KV` | 保存后台模型配置、用户、API Key 哈希、用量记录和异步任务记录。未绑定时退回内存存储，跨 isolate 可能丢失。 |
| `TASK_QUEUE` | 创建异步任务后发送队列消息。未绑定时只保存任务，不入队。 |
| `DB` | 当前 MVP 主要用于后台状态和告警展示，租户、API Key、配额和计费持久化尚未实现。 |
| `FILES` | R2 文件转存和受控读取。任务输出转存后会以 R2 object key 存储，查询任务时返回带域名的访问 URL。 |

管理后台会展示这些绑定是否存在，并在缺少关键配置时给出 warning。

## 线上部署建议

非敏感默认值可以放在 `wrangler.toml` 的 `[vars]`：

```toml
[vars]
OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1"
OPENAI_COMPATIBLE_DEFAULT_MODEL = "gpt-4o-mini"
```

敏感值用 Secret：

```bash
wrangler secret put ADMIN_TOKEN
wrangler secret put DEV_API_KEY
wrangler secret put OPENAI_COMPATIBLE_API_KEY
```

如果 `OPENAI_COMPATIBLE_BASE_URL` 和 `OPENAI_COMPATIBLE_DEFAULT_MODEL` 仍使用默认值，可以不写在 `wrangler.toml` 里。

## 模力方舟异步接口配置

`moark-async` 是用于对接模力方舟（Gitee AI）异步图像生成接口的 Provider Plugin。

### 请求流程

1. 用户请求 `POST /v1/async/images/generations`，请求体中指定 `model` 为平台模型别名。
2. 网关根据配置找到对应的上游实例和提供者插件。
3. 网关将请求转发到模力方舟的异步接口 `POST /v1/async/images/generations`。
4. 模力方舟返回 `task_id` 和异步任务状态。
5. 网关创建本地异步任务记录并返回 `202 Accepted` 和 `task_id` 给用户。
6. 用户可通过 `GET /v1/tasks/{task_id}` 查询任务状态。
7. 后台通过异步队列对已发送到上游的任务进行轮询，获取最终结果。

### 配置示例

```json
{
  "upstreams": [
    {
      "id": "moark-image-gen",
      "name": "Moark Async Image Generation",
      "plugin_id": "moark-async",
      "base_url": "https://ai.gitee.com/api/v1",
      "credential_id": "env:MOARK_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "Qwen-Image",
          "provider_model": "Qwen-Image",
          "modality": "image",
          "supports_async": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

### 环境变量配置

在 `.dev.vars` 或 Cloudflare Secret 中设置 API Key：

```bash
MOARK_API_KEY=your-moark-api-key
```

### 请求示例

创建异步图像生成任务：

```bash
curl -X POST http://localhost:8787/v1/async/images/generations \
  -H "Authorization: Bearer dev-only-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen-Image",
    "prompt": "A beautiful sunset over mountains",
    "n": 1,
    "width": 1024,
    "height": 1024,
    "response_format": "url"
  }'
```

响应示例（202 Accepted）：

```json
{
  "id": "task_abc123def456",
  "object": "task",
  "type": "image_generation",
  "status": "queued",
  "created_at": "2026-06-16T15:30:00Z",
  "updated_at": "2026-06-16T15:30:00Z"
}
```

### 支持的模型属性

- `supports_async`：标记该模型是否支持异步模式（必须为 `true`）。
- `modality`：模式必须为 `image`。
- 其他属性与同步接口相同。

### 关键字段说明

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `supports_async` | 模型是否支持异步执行 | `true` |
| `modality` | 模型模式，图像生成应为 `image` | `"image"` |
| `plugin_id` | 提供者插件 ID | `"moark-async"` |
| `base_url` | 模力方舟 API Base URL | `"https://ai.gitee.com/api/v1"` |
| `credential_id` | API 凭证配置引用 | `"env:MOARK_API_KEY"` |

默认创建路径为 `/async/images/generations`，默认轮询路径为 `/task/{task_id}`。如果上游路径发生变化，可在 upstream 的 `config` 中覆盖：`create_url`、`poll_url`，或 `create_path`、`poll_path`。`poll_url` / `poll_path` 中可使用 `{task_id}` 占位符。
