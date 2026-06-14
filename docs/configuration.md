# 配置说明

本文档说明项目当前识别的环境变量、Cloudflare 绑定，以及当前采用的“协议 -> 上游 -> 模型”配置分层。

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
| `MODEL_CONFIG_JSON` | 覆盖默认上游实例和上游模型配置。 | 可选 | 自动生成一个默认上游和默认模型 |

## 配置分层

配置顺序应该是先配置协议和上游，再在上游下添加模型：

1. 选择协议类型和 Provider Plugin，例如 OpenAI 兼容格式、异步轮询任务协议、异步 webhook 任务协议或私有协议插件。
2. 配置上游实例，把协议类型、endpoint、区域、凭证和健康检查状态绑定到一个稳定的上游 ID。
3. 在上游实例下添加模型条目，只填写平台模型别名、上游真实模型名和模型能力。

这样可以把“怎么调用某类上游”和“这次实际调用哪个模型”拆开。同一个 OpenAI 兼容协议插件可以配置多个上游，例如 OpenAI 官方、硅基流动兼容接口、私有 vLLM 网关；同一个上游也可以承载多个平台模型别名。模型添加时不再单独填写密钥、域名或 base URL，这些只属于上游实例。

| 层级 | 保存内容 | 示例 | 用户是否可见 |
| --- | --- | --- | --- |
| 协议或插件 | 协议转换、流式解析、任务状态映射、错误归一。 | `openai-compatible`、`modelark` | 否 |
| 上游实例 | 协议类型、插件、base URL、凭证引用、区域、协议参数、状态。 | `openai-main`、`siliconflow-cn` | 否 |
| 上游模型 | 对外模型名、上游真实模型名、能力、优先级和权重，不含密钥和域名。 | `fast-chat` -> `Qwen/Qwen2.5-72B-Instruct` | 别名可见 |

配置示例：

```json
{
  "upstreams": [
    {
      "id": "openai-main",
      "name": "OpenAI official",
      "protocol_type": "openai-compatible",
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
      "protocol_type": "openai-compatible",
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
      "protocol_type": "private",
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
4. 网关从所属上游实例读取 `protocol_type`、`plugin_id`、`base_url`、`credential_id` 和协议参数。
5. 网关把请求转发到上游 `base_url + /chat/completions`，并把请求体里的 `model` 改成上游模型条目的 `provider_model`。

默认情况下，不配置 `MODEL_CONFIG_JSON` 时等价于下面这份配置：

```json
{
  "upstreams": [
    {
      "id": "openai-compatible-default",
      "name": "OpenAI Compatible Default",
      "protocol_type": "openai-compatible",
      "plugin_id": "openai-compatible",
      "provider": "openai-compatible",
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

`MODEL_CONFIG_JSON` 当前用于替代自动生成的默认上游和模型配置。它适合配置多个协议类型、多个上游、多个模型别名或不同上游模型名。

字段含义：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `upstreams` | 根对象 | 上游实例数组。 |
| `id` | upstream | 上游实例 ID，例如 `openai-main`。 |
| `name` | upstream | 管理后台展示名。 |
| `protocol_type` | upstream | 协议类型，例如 `openai-compatible`、`private`、`async-polling-task`。 |
| `plugin_id` | upstream | 处理该上游协议的 Provider Plugin ID。 |
| `base_url` | upstream | 上游 API Base URL。 |
| `credential_id` | upstream | 上游凭证位置或凭证记录 ID。 |
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
      "protocol_type": "openai-compatible",
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

## Cloudflare 绑定

这些不是普通 `[vars]`，而是 Cloudflare Worker 绑定。当前代码会识别以下绑定名称：

| 绑定 | 当前作用 |
| --- | --- |
| `AI_GATEWAY_KV` | 保存后台模型配置、用户、API Key 哈希、用量记录和异步任务记录。未绑定时退回内存存储，跨 isolate 可能丢失。 |
| `TASK_QUEUE` | 创建异步任务后发送队列消息。未绑定时只保存任务，不入队。 |
| `DB` | 当前 MVP 主要用于后台状态和告警展示，租户、API Key、配额和计费持久化尚未实现。 |
| `FILES` | 当前 MVP 主要用于后台状态展示，R2 文件转存能力尚未完整接入。 |

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
