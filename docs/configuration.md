# 配置说明

本文档说明项目当前识别的环境变量、Cloudflare 绑定、当前 MVP 的模型路由格式，以及后续应采用的“协议 -> 上游 -> 模型”配置分层。

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
| `MODEL_CONFIG_JSON` | 覆盖默认模型列表和当前扁平 Provider 路由。 | 可选 | 自动生成一个默认模型 |

## 配置分层

目标配置顺序应该是先配置协议和上游，再配置模型：

1. 选择协议或 Provider Plugin，例如 `openai-compatible`、异步轮询任务协议、异步 webhook 任务协议或私有协议插件。
2. 配置上游实例，把协议、endpoint、区域、凭证和健康检查状态绑定到一个稳定的 `upstream_id`。
3. 配置平台模型别名，把用户看到的 `model` 路由到某个 `upstream_id` 上的真实上游模型名。

这样可以把“怎么调用某类上游”和“这次实际调用哪个模型”拆开。同一个 OpenAI 兼容协议插件可以配置多个上游，例如 OpenAI 官方、硅基流动兼容接口、私有 vLLM 网关；同一个上游也可以承载多个平台模型别名。

| 层级 | 保存内容 | 示例 | 用户是否可见 |
| --- | --- | --- | --- |
| 协议或插件 | 协议转换、流式解析、任务状态映射、错误归一。 | `openai-compatible`、`modelark` | 否 |
| 上游实例 | 使用哪个插件、base URL、凭证引用、区域、协议参数、状态。 | `openai-main`、`siliconflow-cn` | 否 |
| 模型别名 | 对外模型名、能力、路由优先级和上游真实模型名。 | `fast-chat` -> `siliconflow-cn` / `Qwen/Qwen2.5-72B-Instruct` | 是 |

目标配置示例：

```json
{
  "upstreams": [
    {
      "id": "openai-main",
      "name": "OpenAI official",
      "plugin_id": "openai-compatible",
      "protocol": "openai-chat-completions",
      "base_url": "https://api.openai.com/v1",
      "credential_id": "env:OPENAI_API_KEY",
      "status": "active"
    },
    {
      "id": "siliconflow-cn",
      "name": "SiliconFlow CN",
      "plugin_id": "openai-compatible",
      "protocol": "openai-chat-completions",
      "base_url": "https://api.siliconflow.cn/v1",
      "credential_id": "env:SILICONFLOW_API_KEY",
      "status": "active"
    }
  ],
  "models": [
    {
      "alias": "fast-chat",
      "modality": "text",
      "supports_stream": true,
      "status": "active",
      "routes": [
        {
          "upstream_id": "siliconflow-cn",
          "provider_model": "Qwen/Qwen2.5-72B-Instruct",
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

当前代码里的 `GatewayConfig` 还没有独立的 `upstreams` 数组，`routes[]` 暂时把 `plugin_id`、`provider`、`credential_id` 和 `provider_model` 写在一起。实施上游实例层时，应先确认是否已有线上 KV 或 `MODEL_CONFIG_JSON` 持久化配置；如果没有已发布配置，可以直接切换到上面的目标结构，如果已有配置，则需要明确一次迁移策略。

## OpenAI 兼容配置

`openai-compatible` 是当前内置的 Provider Plugin，用来代理所有兼容 OpenAI `chat/completions` 协议的上游。

当前 MVP 请求流程如下：

1. 用户请求 `POST /v1/chat/completions`，请求体里的 `model` 是平台模型别名。
2. 网关读取 `MODEL_CONFIG_JSON`。如果没有配置，则用 `OPENAI_COMPATIBLE_DEFAULT_MODEL` 自动生成一个默认模型。
3. 网关按模型别名找到路由，选择优先级最小的 active route。
4. 网关读取 route 的 `credential_id`，默认是 `env:OPENAI_COMPATIBLE_API_KEY`。
5. 网关把请求转发到 `OPENAI_COMPATIBLE_BASE_URL + /chat/completions`，并把请求体里的 `model` 改成 route 的 `provider_model`。

目标结构中，第 4 步应改为读取 route 的 `upstream_id`，再从上游实例读取 `plugin_id`、`base_url`、`credential_id` 和协议参数。模型路由不再直接保存 endpoint 和凭证。

默认情况下，不配置 `MODEL_CONFIG_JSON` 时等价于下面这份配置：

```json
{
  "models": [
    {
      "alias": "gpt-4o-mini",
      "modality": "text",
      "supports_stream": true,
      "status": "active",
      "routes": [
        {
          "plugin_id": "openai-compatible",
          "provider": "openai-compatible",
          "provider_model": "gpt-4o-mini",
          "credential_id": "env:OPENAI_COMPATIBLE_API_KEY",
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
| 暴露多个模型别名 | 配置 `MODEL_CONFIG_JSON`。 |
| 不想在本地传 Bearer Token | 设置 `AUTH_MODE=none`。不要在线上使用。 |

## MODEL_CONFIG_JSON

`MODEL_CONFIG_JSON` 当前用于替代自动生成的默认模型配置。它适合配置多个模型别名、多个路由或不同上游模型名。

字段含义：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `models` | 根对象 | 模型数组，必填。 |
| `alias` | model | 对用户暴露的模型名，也是 `/v1/models` 返回的 `id`。 |
| `modality` | model | 模型类型，当前文本聊天接口要求为 `text`。 |
| `supports_stream` | model | 是否允许 `stream: true`。设置为 `false` 会拒绝流式请求。 |
| `status` | model/route | `disabled` 会禁用模型或路由。未设置视为 active。 |
| `routes` | model | Provider 路由数组，必填。 |
| `plugin_id` | route | Provider Plugin ID，当前内置 `openai-compatible`。 |
| `provider_model` | route | 上游真实模型名。转发请求时会替换到上游 `model` 字段。 |
| `credential_id` | route | 上游凭证位置。`env:OPENAI_COMPATIBLE_API_KEY` 表示读取同名环境变量。 |
| `priority` | route | 路由优先级，数字越小越优先。当前 MVP 只选择优先级最小的路由。 |
| `weight` | route | 预留给加权路由。当前 MVP 尚未按权重分流。 |

目标结构增加以下字段：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `upstreams` | 根对象 | 上游实例数组，模型路由通过 `upstream_id` 引用。 |
| `id` | upstream | 上游实例 ID，例如 `openai-main`。 |
| `name` | upstream | 管理后台展示名。 |
| `plugin_id` | upstream | 处理该上游协议的 Provider Plugin ID。 |
| `protocol` | upstream | 协议或接口形态，例如 `openai-chat-completions`、`async-polling-task`。 |
| `base_url` | upstream | 上游 API Base URL。 |
| `credential_id` | upstream | 上游凭证位置或凭证记录 ID。 |
| `config` | upstream | 协议相关的非密钥配置，例如 region、api_version、poll_interval_seconds。 |
| `upstream_id` | route | 路由目标上游实例。实施后应替代 route 里的 `plugin_id`、`provider` 和 `credential_id`。 |

示例：对外暴露 `fast-chat`，实际调用上游 `gpt-4o-mini`：

```json
{
  "models": [
    {
      "alias": "fast-chat",
      "modality": "text",
      "supports_stream": true,
      "status": "active",
      "routes": [
        {
          "plugin_id": "openai-compatible",
          "provider_model": "gpt-4o-mini",
          "credential_id": "env:OPENAI_COMPATIBLE_API_KEY",
          "priority": 1,
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
