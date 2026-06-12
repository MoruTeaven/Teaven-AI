# Teaven AI Gateway

Teaven AI Gateway 是一个计划部署在 Cloudflare 上的多租户 AI 基础设施项目。它面向平台用户提供统一的 OpenAI 兼容调用入口，并通过插件化 Provider 架构适配各种上游模型服务商。

项目定位类似 NewAPI，但目标范围更聚焦：

- 文本 LLM：兼容 OpenAI API，支持流式响应。
- 图片、视频及其他文件类能力：统一为异步任务，不走同步流式接口。
- 多用户、多 API Key、多上游插件、多模型路由。
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

新增上游不应改变对外 API、任务状态、计费格式和错误格式，只需要新增或启用对应 Provider Plugin，并配置模型路由。

Provider Adapter 还需要声明上游能力和执行模式，例如文本是否支持流式、图片生成是同步还是异步、异步结果需要轮询还是 webhook。平台根据这些声明选择执行流程，但不改变对外 API 形态。

## Cloudflare 部署设想

- Cloudflare Workers：统一 API 网关、OpenAI 兼容接口、上游代理。
- Cloudflare D1：租户、用户、Key、模型路由、任务、账单汇总等关系型数据。
- Cloudflare KV：模型配置、路由配置、短期缓存和开关配置。
- Cloudflare R2：上传文件、需要转存的异步任务输出、日志归档；业务文件默认最多保存 24 小时。
- Cloudflare Queues：异步媒体任务调度、webhook 投递、日志后处理。
- Durable Objects：可选，用于强一致的 per-key 限流、并发控制或流式连接状态管理。
- Cron Triggers：任务补偿、超时检查、用量汇总和清理。

## 文档

- [技术设计](docs/technical-design.md)
- [Provider 插件开发指南](docs/provider-plugin-guide.md)

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
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `POST /v1/tasks/{task_id}/cancel`

默认鉴权使用 `.dev.vars` 中的 `DEV_API_KEY`。请求示例：

```http
Authorization: Bearer dev-only-change-me
```

默认内置一个 `openai-compatible` Provider Plugin，使用：

- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_DEFAULT_MODEL`

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
