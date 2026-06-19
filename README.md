# Teaven AI Gateway

Teaven AI Gateway 是一个计划部署在 Cloudflare 上的多租户 AI 基础设施项目。它面向平台用户提供统一的 OpenAI 兼容调用入口，并通过插件化 Provider 架构适配各种上游模型服务商。

项目定位类似 NewAPI，但目标范围更聚焦：

- 文本 LLM：兼容 OpenAI API，支持流式响应。
- 图片、视频及其他文件类能力：统一为异步任务，不走同步流式接口。
- 多用户、多 API Key、多上游插件、多上游模型路由。
- 在 Cloudflare Workers 体系内优先实现低运维、边缘化、高可用的网关能力。

## 核心目标

- 对用户暴露统一接口，降低不同上游的接入成本。
- 对平台内部统一鉴权、限流、配额、计费、日志和审计。
- 对上游供应商做模型别名、协议转换、错误归一、重试和故障切换。
- 上游以插件形式扩展，核心平台不绑定固定供应商清单。
- 文本接口直接适配 OpenAI `chat/completions` 的请求、响应和 SSE 流式协议。
- 媒体类任务全部通过异步任务模型承载，避免长耗时同步请求占用边缘连接。

## 能力范围

### 统一接口原则

对外接口由平台定义，不直接暴露上游供应商的真实协议形态。上游可以是同步、异步、轮询、回调或非标准接口，但用户始终按 Teaven AI Gateway 的统一接口调用。

| 上游形态 | 示例 | 平台处理方式 |
| --- | --- | --- |
| 文本流式 | OpenAI 兼容文本模型 | 对外保持 `/v1/chat/completions` 和 OpenAI SSE 流式协议。 |
| 媒体仅异步 | 模力方舟生图 | 对外创建平台任务，内部保存上游任务 ID，后台轮询或接收回调后更新结果。 |
| 媒体仅同步 | 硅基流动生图 | 对外仍创建平台任务，后台 Worker 调用同步上游，拿到结果后写入 R2 并完成任务。 |
| 非统一规范 | 讯飞星辰等 | 通过 Provider Adapter 转换鉴权、请求、响应、错误码和任务状态。 |

因此，图片、视频和文件类能力即使上游支持同步返回，平台对外也统一为异步任务接口，避免用户感知上游差异。

### 文本 LLM

- `POST /v1/chat/completions`
- 支持 `stream: true` 的 OpenAI 兼容 SSE 输出。
- 支持非流式文本响应。
- 支持模型别名，例如将 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus` 映射到不同上游。
- 支持按租户、API Key、模型、上游进行限流和配额控制。

### 异步媒体任务

- 图片生成、视频生成、文件处理等能力统一为异步任务。
- 用户提交任务后获得 `task_id`。
- 用户通过查询接口或 webhook 获取最终结果。
- 文件仅在需要平台托管时存储到 Cloudflare R2，默认最多保存 24 小时，到期删除。
- 任务支持 `store_output` 控制是否转存结果文件，默认不转存，直接返回上游链接。
- 如果上游只返回 base64 或二进制内容，平台会强制转存到 R2，并按文件存储时长删除。

### 上游适配

上游不是固定清单，而是通过 Provider Plugin 自由扩充。一个 Provider Plugin 至少包含：

- 插件清单：插件 ID、名称、版本、能力、配置 schema。
- Adapter 实现：鉴权、请求转换、响应转换、流式解析、错误映射、用量提取。
- 执行模式声明：同步、异步轮询、异步回调、流式、非流式。
- 凭证配置：上游 Key、签名密钥、endpoint、区域等。
- 默认模型映射：可选，用于快速把上游模型注册为平台模型别名。

官方或内置插件可以先提供 OpenAI 兼容、硅基流动、模力方舟等实现；其他供应商，例如讯飞星辰或私有模型服务，也应通过同一插件接口接入。

新增上游不应改变对外 API、任务状态、计费格式和错误格式。接入顺序应是先新增或启用对应 Provider Plugin，再配置上游实例，最后在上游实例下添加模型别名和上游真实模型名。

Provider Adapter 还需要声明上游能力和执行模式，例如文本是否支持流式、图片生成是同步还是异步、异步结果需要轮询还是 webhook。平台根据这些声明选择执行流程，但不改变对外 API 形态。

## Cloudflare 部署设想

- Cloudflare Workers：统一 API 网关、OpenAI 兼容接口、上游代理。
- Cloudflare D1：租户、用户、Key、上游模型路由、任务、账单汇总等关系型数据。
- Cloudflare KV：模型配置、路由配置、短期缓存和开关配置。
- Cloudflare R2：上传文件、需要转存的异步任务输出、日志归档；业务文件默认最多保存 24 小时。
- Cloudflare Queues：异步媒体任务调度、webhook 投递、日志后处理。
- Durable Objects：可选，用于强一致的 per-key 限流、并发控制或流式连接状态管理。
- Cron Triggers：任务补偿、超时检查、用量汇总和清理。

## 文档

- [技术设计](docs/technical-design.md)
- [Provider 插件开发指南](docs/provider-plugin-guide.md)
- [配置说明](docs/configuration.md)

## 本地开发

要求 Node.js 22+，Wrangler 4 需要该版本或更高版本。

安装依赖：

```bash
npm install
```

复制本地环境变量示例并填入真实密钥：

```bash
cp .dev.vars.example .dev.vars
```

启动 Worker：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

当前 MVP 已实现：

- `GET /health`
- `GET /admin`
- `GET /account`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `POST /v1/tasks/{task_id}/cancel`

默认鉴权使用 `.dev.vars` 中的 `DEV_API_KEY`。请求示例：

```http
Authorization: Bearer dev-only-change-me
```

### 管理员后台

本地启动后访问：

```text
http://localhost:8787/admin
```

管理员后台使用独立的 `ADMIN_TOKEN` 作为管理员密码。访问 `/admin` 会先跳转到登录页；登录成功后服务端写入 HttpOnly 会话 Cookie，并自动进入管理后台。

当前后台支持：

- 侧栏导航、深色/浅色主题切换和响应式布局。
- 网关配置来源、鉴权模式和 Cloudflare 绑定状态概览。
- 功能状态矩阵、接口清单、告警和部署缺口提示。
- 模型管理：创建、更新、删除、重置模型配置，并立即作为网关实际路由配置生效。
- 用户管理：创建用户、启用/禁用用户、查看/启用/禁用 API Key、配置 Key 可访问模型。API Key 创建应由用户中心提供。
- 模型用量：记录聊天补全和任务创建用量，按模型聚合请求数、token 和媒体单位。
- 上游配置、上游模型、运行时路由、Provider 插件和上游凭证状态查看。
- Provider 静态健康检查。
- 异步任务列表、状态过滤、关键词搜索、任务详情和管理员取消任务。
- 当前 `GatewayConfig` 导出、API 调用示例和 `MODEL_CONFIG_JSON` 格式校验。

后台保存的模型、用户、API Key 和用量记录优先写入 `AI_GATEWAY_KV`；未绑定 KV 时会退回内存存储，仅适合本地开发。API Key 明文只应在用户中心创建时展示一次，后台只保存哈希和前缀。

示例本地环境变量：

```bash
ADMIN_TOKEN=admin-dev-only-change-me
```

### 用户中心

本地启动后访问：

```text
http://localhost:8787/account
```

用户中心使用 `USER_CENTER_TOKEN` 作为当前 MVP 的访问口令。首次使用邮箱和访问口令登录时会自动创建用户；登录后支持：

- 查看个人资料、租户 ID、可用模型和存储状态。
- 自助创建 API Key，密钥明文只展示一次。
- 禁用自己的 API Key，配置 Key 可访问模型和过期时间。
- 查看当前用户的用量汇总和最近异步任务。
- 取消当前租户下仍处于 queued/running 状态的任务。

#### 用户中心接口文档

基础约定：

| 项目 | 说明 |
| --- | --- |
| Base URL | 本地开发为 `http://localhost:8787`，线上按 Worker 部署域名替换 |
| 页面入口 | `GET /account`，未登录会跳转到 `/account/login` |
| 鉴权方式 | 用户中心 JSON API 使用 `teaven_account_session` Cookie 会话鉴权，不使用 `Authorization: Bearer` |
| 会话有效期 | 7 天，Cookie 属性为 `HttpOnly; SameSite=Lax; Path=/account`，HTTPS 下自动增加 `Secure` |
| 登录口令 | 推荐配置 `USER_CENTER_TOKEN`；代码未配置时会退回使用 `ADMIN_TOKEN` 作为访问口令 |
| JSON 请求头 | 带 JSON 请求体的接口必须使用 `Content-Type: application/json` |
| 响应头 | JSON API 会返回 `Content-Type: application/json; charset=utf-8` 和 `X-Request-Id` |
| 存储 | 绑定 `AI_GATEWAY_KV` 时为持久化存储；未绑定时退回内存，仅适合本地开发 |

网页登录接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/account/login` | 返回用户中心登录页；已登录时跳转到 `/account` |
| `POST` | `/account/login` | 提交表单登录，字段为 `email` 和 `access_token`；首次登录会自动创建用户 |
| `POST` | `/account/logout` | 清除用户中心 Cookie，并跳转到 `/account/login` |
| `GET` | `/account` | 返回用户中心页面；未登录时跳转到 `/account/login` |

错误响应统一格式：

```json
{
  "error": {
    "message": "name is required",
    "type": "invalid_request_error",
    "param": "name",
    "code": "invalid_request"
  }
}
```

常见状态码：

| 状态码 | 场景 |
| --- | --- |
| `200` | 请求成功 |
| `201` | API Key 创建成功 |
| `202` | 异步测试任务已创建 |
| `400` | 请求体、字段类型或参数不合法 |
| `401` | 用户中心未配置访问口令、会话无效或会话过期 |
| `404` | 接口、API Key 或任务不存在，或资源不属于当前用户 |
| `409` | 任务当前状态不可取消 |
| `500` | 服务端内部错误 |

通用对象字段：

| 对象 | 字段 | 说明 |
| --- | --- | --- |
| `user` | `id` | 用户 ID |
| `user` | `organization_id` | 租户 ID，用户中心按租户隔离用量、任务和 API Key |
| `user` | `email` | 登录邮箱 |
| `user` | `name` | 用户显示名，未设置时为 `null` |
| `user` | `role` | 用户角色，当前用户中心自动创建用户为 `member` |
| `user` | `status` | 用户状态，`active` 或 `disabled` |
| `user` | `created_at` / `updated_at` | ISO 8601 时间字符串 |
| `api_key` | `id` | API Key ID，用于更新、禁用和查看明文 |
| `api_key` | `organization_id` / `user_id` | API Key 所属租户和用户 |
| `api_key` | `name` | API Key 名称 |
| `api_key` | `key_prefix` | API Key 前缀，仅用于识别，不是完整密钥 |
| `api_key` | `allowed_models` | 可访问模型列表；空数组表示不限制模型 |
| `api_key` | `status` | `active`、`disabled` 或历史数据中的 `expired` |
| `api_key` | `expires_at` | 过期时间，未设置时为 `null` |
| `api_key` | `last_used_at` | 最近使用时间，尚未使用时为 `null` |
| `usage` | `total_requests` | 当前用户 API Key 产生的总请求数 |
| `usage` | `total_tokens` / `prompt_tokens` / `completion_tokens` | Token 用量汇总 |
| `usage` | `media_count` | 图片、视频、文件等媒体单位数量 |
| `usage` | `cost` | 成本字段，当前按记录聚合 |
| `usage` | `by_model` | 按模型聚合的用量列表，按请求数降序 |
| `usage` | `recent` | 最近 50 条用量明细，按创建时间倒序 |
| `task` | `id` | 异步任务 ID |
| `task` | `type` | 任务类型，例如 `image.generation`、`video.generation`、`file.processing` |
| `task` | `model` | 任务使用的模型别名 |
| `task` | `status` | `queued`、`running`、`succeeded`、`failed`、`canceled` 或 `expired` |
| `task` | `cancelable` | 是否可取消，仅 `queued` 和 `running` 为 `true` |
| `task` | `diagnostics` | 上游、Provider、轮询次数和最近错误等诊断信息 |
| `task` | `last_event` | 最近一条任务事件 |
| `task` | `error` | 任务错误信息，无错误时为 `null` |
| `model` | `id` | 模型别名，调用网关时作为 `model` 传入 |
| `model` | `modality` | `text`、`image`、`video` 或 `file` |
| `model` | `supports_stream` | 是否支持流式文本调用 |
| `model` | `supports_async` | 是否支持异步任务 |
| `model` | `status` | 模型状态，用户中心只返回非 `disabled` 模型 |

获取用户中心首页数据：

```http
GET /account/api/profile
Cookie: teaven_account_session=<session>
```

返回当前用户、API Key、用量、最近任务、可用模型和存储状态。`tasks` 默认最多返回当前租户最近 50 条任务。

```json
{
  "user": {
    "id": "user_xxx",
    "organization_id": "organization_xxx",
    "email": "user@example.com",
    "name": "张三",
    "role": "member",
    "status": "active",
    "created_at": "2026-06-20T08:00:00.000Z",
    "updated_at": "2026-06-20T08:00:00.000Z"
  },
  "api_keys": [
    {
      "id": "key_xxx",
      "organization_id": "organization_xxx",
      "user_id": "user_xxx",
      "name": "生产环境",
      "key_prefix": "tvai_xxxxxxxxx",
      "allowed_models": ["gpt-4o-mini"],
      "status": "active",
      "expires_at": null,
      "created_at": "2026-06-20T08:00:00.000Z",
      "updated_at": "2026-06-20T08:00:00.000Z",
      "last_used_at": null
    }
  ],
  "usage": {
    "total_requests": 0,
    "total_tokens": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "media_count": 0,
    "cost": 0,
    "by_model": [],
    "recent": []
  },
  "tasks": [],
  "models": [
    {
      "id": "gpt-4o-mini",
      "modality": "text",
      "supports_stream": true,
      "supports_async": true,
      "status": "active"
    }
  ],
  "storage": {
    "durable": true,
    "source": "AI_GATEWAY_KV"
  }
}
```

更新个人资料：

```http
PATCH /account/api/profile
Content-Type: application/json
Cookie: teaven_account_session=<session>

{
  "name": "张三"
}
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string \| null` | 否 | 用户显示名；不传保持当前值，传空字符串或 `null` 清空显示名 |

响应：

```json
{
  "user": {
    "id": "user_xxx",
    "organization_id": "organization_xxx",
    "email": "user@example.com",
    "name": "张三",
    "role": "member",
    "status": "active",
    "created_at": "2026-06-20T08:00:00.000Z",
    "updated_at": "2026-06-20T08:05:00.000Z"
  }
}
```

获取用量汇总：

```http
GET /account/api/usage
Cookie: teaven_account_session=<session>
```

响应：

```json
{
  "usage": {
    "total_requests": 12,
    "total_tokens": 3456,
    "prompt_tokens": 1200,
    "completion_tokens": 2256,
    "media_count": 0,
    "cost": 0,
    "by_model": [
      {
        "model": "gpt-4o-mini",
        "requests": 12,
        "total_tokens": 3456,
        "prompt_tokens": 1200,
        "completion_tokens": 2256,
        "media_count": 0,
        "cost": 0
      }
    ],
    "recent": [
      {
        "id": "usage_xxx",
        "request_id": "req_xxx",
        "organization_id": "organization_xxx",
        "api_key_id": "key_xxx",
        "endpoint": "/v1/chat/completions",
        "model": "gpt-4o-mini",
        "status_code": 200,
        "latency_ms": 860,
        "stream": false,
        "prompt_tokens": 100,
        "completion_tokens": 188,
        "total_tokens": 288,
        "media_count": 0,
        "cost": 0,
        "created_at": "2026-06-20T08:10:00.000Z"
      }
    ]
  }
}
```

创建 API Key：

```http
POST /account/api/api-keys
Content-Type: application/json
Cookie: teaven_account_session=<session>

{
  "name": "生产环境",
  "allowed_models": ["gpt-4o-mini"],
  "expires_at": "2026-12-31T23:59:59.000Z"
}
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 否 | API Key 名称；不传或传空字符串时使用 `默认密钥` |
| `allowed_models` | `string[] \| null` | 否 | 限制该 Key 可调用的模型；不传、`null`、空字符串或空数组表示不限制 |
| `expires_at` | `string \| null` | 否 | ISO 8601 过期时间；不传、`null` 或空字符串表示永不过期 |

响应状态码为 `201`。`secret` 是完整 API Key 明文，创建时必须立即保存；后续常规列表只返回 `key_prefix`。

```json
{
  "api_key": {
    "id": "key_xxx",
    "organization_id": "organization_xxx",
    "user_id": "user_xxx",
    "name": "生产环境",
    "key_prefix": "tvai_xxxxxxxxx",
    "allowed_models": ["gpt-4o-mini"],
    "status": "active",
    "expires_at": "2026-12-31T23:59:59.000Z",
    "created_at": "2026-06-20T08:00:00.000Z",
    "updated_at": "2026-06-20T08:00:00.000Z",
    "last_used_at": null
  },
  "secret": "tvai_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "warning": "请立即复制保存，密钥明文只会显示一次。"
}
```

更新 API Key：

```http
PATCH /account/api/api-keys/{api_key_id}
Content-Type: application/json
Cookie: teaven_account_session=<session>

{
  "name": "生产环境-只读",
  "status": "active",
  "allowed_models": ["gpt-4o-mini"],
  "expires_at": null
}
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 否 | 新名称，传入时不能为空字符串 |
| `status` | `string` | 否 | 只能为 `active` 或 `disabled` |
| `allowed_models` | `string[] \| null` | 否 | 新模型限制；传 `null`、空字符串或空数组可清空限制 |
| `expires_at` | `string \| null` | 否 | 新过期时间；传 `null` 或空字符串可清除过期时间 |

响应：

```json
{
  "api_key": {
    "id": "key_xxx",
    "organization_id": "organization_xxx",
    "user_id": "user_xxx",
    "name": "生产环境-只读",
    "key_prefix": "tvai_xxxxxxxxx",
    "allowed_models": ["gpt-4o-mini"],
    "status": "active",
    "expires_at": null,
    "created_at": "2026-06-20T08:00:00.000Z",
    "updated_at": "2026-06-20T08:15:00.000Z",
    "last_used_at": null
  }
}
```

禁用 API Key：

```http
DELETE /account/api/api-keys/{api_key_id}
Cookie: teaven_account_session=<session>
```

该接口不会物理删除数据，只会把当前用户自己的 API Key 状态改为 `disabled`。

查看 API Key 明文：

```http
POST /account/api/api-keys/{api_key_id}/reveal
Content-Type: application/json
Cookie: teaven_account_session=<session>

{
  "access_token": "user-center-dev-only-change-me"
}
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `access_token` | `string` | 是 | 用户中心访问口令，用于二次确认 |

响应：

```json
{
  "api_key_id": "key_xxx",
  "token": "tvai_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

说明：仅支持查看当前版本创建并保存了加密明文的 Key。旧版本 Key 如果没有 `encrypted_key`，会返回 `404`，需要重新创建。

列出任务：

```http
GET /account/api/tasks?limit=50
Cookie: teaven_account_session=<session>
```

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | `number` | 否 | 返回数量，默认 `50`，最小 `1`，最大 `100`；非数字时使用默认值 |

响应：

```json
{
  "object": "list",
  "data": [
    {
      "id": "task_xxx",
      "type": "image.generation",
      "model": "image-model",
      "status": "running",
      "upstream_id": "openai",
      "plugin_id": "openai-compatible",
      "provider_task_id": "provider_task_xxx",
      "cancelable": true,
      "store_output": true,
      "diagnostics": {
        "upstream_id": "openai",
        "plugin_id": "openai-compatible",
        "provider_execution_mode": null,
        "provider_task_id": "provider_task_xxx",
        "provider_status": "running",
        "provider_response_code": null,
        "provider_http_status": 200,
        "poll_count": 1,
        "create_attempt_count": 1,
        "last_poll_at": "2026-06-20T08:20:00.000Z",
        "next_poll_at": "2026-06-20T08:20:05.000Z",
        "last_error": null,
        "last_event": null
      },
      "last_event": null,
      "created_at": "2026-06-20T08:19:00.000Z",
      "updated_at": "2026-06-20T08:20:00.000Z",
      "completed_at": null,
      "error": null
    }
  ]
}
```

获取任务详情：

```http
GET /account/api/tasks/{task_id}
Cookie: teaven_account_session=<session>
```

任务必须属于当前用户所在租户。详情响应相比列表多出 `object`、`provider_execution_mode`、`input`、`output`、`storage_ttl_seconds`、`output_expires_at`、`callback_url`、`metadata` 和 `events`。

```json
{
  "task": {
    "id": "task_xxx",
    "object": "task",
    "type": "image.generation",
    "model": "image-model",
    "status": "succeeded",
    "upstream_id": "openai",
    "plugin_id": "openai-compatible",
    "provider_execution_mode": "async",
    "provider_task_id": "provider_task_xxx",
    "input": {
      "prompt": "一只橘猫"
    },
    "output": [
      {
        "type": "image",
        "url": "https://example.com/output.png",
        "stored": true,
        "source": "r2",
        "expires_at": "2026-06-21T08:20:00.000Z"
      }
    ],
    "store_output": true,
    "storage_ttl_seconds": 86400,
    "output_expires_at": "2026-06-21T08:20:00.000Z",
    "callback_url": null,
    "metadata": {
      "source": "account_test",
      "user_id": "user_xxx"
    },
    "error": null,
    "diagnostics": {},
    "events": [],
    "created_at": "2026-06-20T08:19:00.000Z",
    "updated_at": "2026-06-20T08:20:00.000Z",
    "completed_at": "2026-06-20T08:20:00.000Z"
  }
}
```

取消任务：

```http
POST /account/api/tasks/{task_id}/cancel
Cookie: teaven_account_session=<session>
```

只有 `queued` 和 `running` 状态的任务可以取消。已完成、失败、已取消或已过期任务会返回 `409`。

模型测试：

```http
POST /account/api/test
Content-Type: application/json
Cookie: teaven_account_session=<session>
```

文本模型请求示例：

```json
{
  "model": "gpt-4o-mini",
  "mode": "sync",
  "prompt": "用一句话介绍 Teaven AI",
  "temperature": 0.7,
  "max_tokens": 1000
}
```

文本模型请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | `string` | 是 | 要测试的模型别名 |
| `mode` | `string` | 否 | `sync` 或 `stream`，默认 `sync`；模型不支持流式时不能使用 `stream` |
| `prompt` | `string` | 是 | 用户输入内容 |
| `temperature` | `number` | 否 | 采样温度，默认 `0.7` |
| `max_tokens` | `number` | 否 | 最大输出 token，默认 `1000` |

文本同步响应：

```json
{
  "mode": "sync",
  "model": "gpt-4o-mini",
  "duration_ms": 860,
  "response": {
    "id": "chatcmpl_xxx",
    "object": "chat.completion"
  }
}
```

文本流式响应会被用户中心接口收集后一次性返回：

```json
{
  "mode": "stream",
  "model": "gpt-4o-mini",
  "duration_ms": 1200,
  "content": "data: ...\n\n"
}
```

非文本模型请求示例：

```json
{
  "model": "image-model",
  "prompt": "一只橘猫",
  "input": {
    "size": "1024x1024"
  },
  "store_output": true,
  "storage_ttl_seconds": 86400
}
```

非文本模型会创建异步任务，响应状态码为 `202`。

```json
{
  "mode": "async_task",
  "model": "image-model",
  "modality": "image",
  "task": {
    "id": "task_xxx",
    "type": "image.generation",
    "model": "image-model",
    "status": "queued",
    "upstream_id": "openai",
    "plugin_id": "openai-compatible",
    "provider_task_id": null,
    "cancelable": true,
    "store_output": true,
    "diagnostics": {},
    "last_event": null,
    "created_at": "2026-06-20T08:19:00.000Z",
    "updated_at": "2026-06-20T08:19:00.000Z",
    "completed_at": null,
    "error": null
  },
  "input": {
    "size": "1024x1024",
    "prompt": "一只橘猫"
  }
}
```

非文本模型请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | `string` | 是 | 要测试的模型别名 |
| `prompt` | `string` | 是 | 可直接传 `prompt`，也可以放在 `input.prompt` 中 |
| `input` | `object` | 否 | 传给任务的模型参数，必须是 JSON 对象 |
| `store_output` | `boolean` | 否 | 是否存储输出文件，只有严格等于 `true` 时启用 |
| `storage_ttl_seconds` | `number` | 否 | 输出存储 TTL，默认 `86400`，范围 `1` 到 `86400`，必须是整数 |

示例本地环境变量：

```bash
USER_CENTER_TOKEN=user-center-dev-only-change-me
```

默认内置一个 `openai-compatible` Provider Plugin，使用：

- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_DEFAULT_MODEL`

`OPENAI_COMPATIBLE_BASE_URL` 和 `OPENAI_COMPATIBLE_DEFAULT_MODEL` 在当前默认值不变时可以省略；`OPENAI_COMPATIBLE_API_KEY` 是默认聊天补全实际调用上游所需的密钥。更多说明见 [配置说明](docs/configuration.md)。

如果需要配置多个模型和路由，可以通过 `MODEL_CONFIG_JSON` 覆盖默认配置。

## MVP 建议

第一阶段先实现：

1. 多租户、API Key、基础鉴权。
2. `POST /v1/chat/completions` OpenAI 兼容接口。
3. Provider Plugin 注册机制。
4. 一个 OpenAI 兼容 Provider Plugin。
5. 文本流式 SSE 透传和错误归一。
6. 基础用量记录和限流。
7. 异步任务接口骨架，不急于接入全部媒体能力。
