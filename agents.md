# Agents Guide

## 项目概览

Teaven AI Gateway 是一个部署在 Cloudflare Workers 上的多租户 AI API 网关。对外提供 OpenAI 兼容文本接口和统一异步任务接口，内部通过 Provider Plugin 适配不同上游模型服务。

核心原则：

- 文本 LLM 使用同步 `/v1/chat/completions`，支持 OpenAI 兼容 SSE 流式响应。
- 图片、视频、文件等耗时或文件型能力统一走异步任务，不直接暴露上游协议。
- 上游差异收敛在 Provider Adapter、任务处理和配置层，避免影响对外 API。
- 密钥、上游凭证和本地真实配置不得提交到仓库。

## 技术栈

- Runtime: Cloudflare Workers
- Language: TypeScript, ESM
- Cloudflare: Wrangler 4, D1, KV, R2, Queues
- Node.js: 22+

## 常用命令

```bash
npm install
npm run dev
npm run typecheck
npm run deploy
```

本地开发前复制环境变量模板：

```bash
cp .dev.vars.example .dev.vars
```

只提交 `.dev.vars.example` 中的占位值，不提交 `.dev.vars` 或真实密钥。

## 重要目录

- `src/index.ts`: Worker HTTP 入口和 Queue Consumer 入口。
- `src/routes/`: HTTP 路由处理，包括管理后台、用户中心、模型、聊天、任务、文件和图片生成。
- `src/providers/`: Provider Plugin、Provider Registry 和上游协议适配。
- `src/tasks/`: 异步任务存储、处理、事件和输出处理。
- `src/auth/`: 用户 API Key、管理员和用户中心鉴权。
- `src/http/`: 统一响应和错误处理。
- `src/admin/`: 管理后台配置与存储逻辑。
- `migrations/`: Cloudflare D1 数据库迁移。
- `docs/`: 技术设计、配置说明和 Provider 插件指南。

## 关键文档

- `README.md`: 项目定位、本地开发、当前接口和使用示例。
- `docs/technical-design.md`: 架构、产品边界、数据模型和 API 设计。
- `docs/configuration.md`: 环境变量、Cloudflare 绑定和模型配置分层。
- `docs/provider-plugin-guide.md`: 新增上游 Provider Plugin 的规范。
- `docs/image-to-image-design.md`: 图生图能力设计。

## 运行时入口

- `fetch(request, env)`: 处理 HTTP 请求，统一加 CORS、错误响应和请求 ID。
- `queue(batch, env)`: 处理异步任务队列消息，调用 `processTask` 执行后台任务。

主要公开路径：

- `GET /health`
- `GET /admin`
- `GET /account`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/async/images/generations`
- `POST /v1/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/{task_id}`
- `POST /v1/tasks/{task_id}/cancel`
- `GET /v1/files/{key}`

## 配置与密钥

本地最小配置参考 `.dev.vars.example`：

```bash
ADMIN_TOKEN=admin-dev-only-change-me
USER_CENTER_TOKEN=user-center-dev-only-change-me
DEV_API_KEY=dev-only-change-me
OPENAI_COMPATIBLE_API_KEY=sk-replace-me
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1
OPENAI_COMPATIBLE_DEFAULT_MODEL=gpt-4o-mini
MOARK_API_KEY=replace-me
```

注意事项：

- 不要把真实 API Key、Token、Cookie、数据库 ID 之外的敏感凭证写入文档或代码。
- 线上密钥优先使用 Cloudflare Worker Secret。
- `credential_id` 支持 `env:SECRET_NAME` 格式，由运行时从 `Env` 读取。
- `wrangler.toml` 只应保存非敏感 Worker 配置和 Cloudflare 绑定。

## 开发规范

- 保持最小正确改动，优先复用现有路由、类型和错误处理工具。
- TypeScript 使用严格模式，新增代码必须通过 `npm run typecheck`。
- 新增对外接口时，统一使用 `jsonResponse`、`errorResponse` 和 `withCors` 的响应约定。
- `/v1/*` 用户接口默认需要 Bearer Token 鉴权，不要绕过 `authenticate`，除非明确处理公开接口。
- Provider 相关变更优先扩展 `src/providers/types.ts` 中的插件能力，不要把上游私有协议泄漏到路由层。
- 媒体和文件类能力应映射到异步任务生命周期，不要新增长耗时同步返回路径。
- API Key 明文只应展示一次，持久化时保存哈希、前缀或必要元数据。
- 新增环境变量时同步更新 `.dev.vars.example`、`docs/configuration.md` 和必要的类型定义。

## Provider 变更指南

新增上游通常按这个顺序处理：

1. 在 `src/providers/` 新增插件实现。
2. 在 `src/providers/registry.ts` 注册插件。
3. 在 `src/providers/types.ts` 补齐必要的能力、请求、响应或执行模式类型。
4. 在配置层加入上游实例和模型别名，不要在模型条目里直接保存密钥。
5. 更新 `docs/provider-plugin-guide.md` 或相关配置文档。

Provider Adapter 负责：

- 鉴权和上游请求构造。
- 上游响应、错误和 usage 归一。
- 流式响应解析。
- 异步任务状态映射。
- 上游文件或 base64 输出的转存决策。

## 异步任务约定

任务状态只使用：

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`
- `expired`

实现任务相关能力时：

- 任务创建后尽快返回 `task_id`。
- 后台执行、轮询或回调结果应写回统一任务记录。
- 需要平台托管的输出写入 R2，并设置过期时间。
- 上游 URL 可以在 `store_output` 为 false 时直接返回，但要保留来源信息。
- 任务事件应记录关键状态变化，便于后台排障。

## 数据与迁移

- D1 schema 变更必须新增 `migrations/*.sql`，不要直接修改已发布迁移。
- KV 可用于管理后台配置、模型和轻量状态，但本地未绑定时可能回退到内存，仅适合开发。
- R2 用于文件上传、任务输出和受控下载。
- Queues 用于异步任务调度和后台处理。

## 验证要求

常规代码变更后至少运行：

```bash
npm run typecheck
```

涉及 Worker 路由或 Cloudflare 绑定时，尽量再运行：

```bash
npm run dev
```

如果无法运行验证，需要在交付说明中写明原因和风险。

## 协作注意事项

- 不要修改 `node_modules/`、`.wrangler/` 或本地状态文件。
- 不要提交 `.dev.vars`、真实密钥、生成的本地数据库文件或日志。
- 仓库可能存在未提交的用户改动，处理任务时不要回滚无关文件。
- 文档更新应保持中文为主，与现有 README 和 docs 风格一致。
- 变更公共行为时同步更新 README 或对应 `docs/` 文档。
