# 部署手册（自建 Node 形态）

本文档描述 **现行生产形态**。本项目历史上是 Cloudflare Workers 项目，配置与文档里仍有若干 CF 残留，本文档先说清现状，再列出哪些是保留的、哪些应当忽略。

## 现状架构

```
用户 → EdgeOne（model.chenyande.com）→ mky.aini2.cn:55555（NAT→80）
     → nginx（/etc/nginx/sites-available/teaven-ai）→ 127.0.0.1:3010
     → Nomad exec（job teaven-ai）→ deploy/start.sh → node dist/server.js
```

| 组件 | 形态 | 位置 |
| --- | --- | --- |
| 运行时 | Node 22 + esbuild bundle | `/opt/apps/teaven-ai/repo/dist/server.js` |
| 进程管理 | Nomad `exec` driver，静态端口 3010 | `deploy/deploy.nomad` |
| 环境变量 | `.env`（权限 600），Node `--env-file` 加载 | `/opt/apps/teaven-ai/.env`，模板见 `deploy/.env.example` |
| 数据库 | PostgreSQL（经 node-postgres 连接池） | `DATABASE_URL`，schema 见 `migrations_pg/schema.sql` |
| 对象存储 | Cloudflare R2，S3 兼容协议直连 | `S3_*` |
| 异步任务 | 库内队列表（`src/adapters/task-queue.ts`），进程内轮询 | 无需 CF Queues |

健康检查：Nomad 每 10 秒 GET `/health`，连续 3 次失败即重启任务。

## 代码是怎么跑起来的

`src/index.ts` 导出 Worker 风格的 `{ fetch, queue }`，全部路由都在这里。两种运行时共用它：

- **自建（生产）**：`src/server/node-entry.ts` 用 `node:http` 起服务，把 PG 连接池和 S3 客户端包装成 Worker 风格的 `Env` 注入进去，再转交 `gateway.fetch(request, env)`。
- **CF Worker（回滚/调试）**：`wrangler dev` / `wrangler deploy` 直接以原生 D1 / KV / R2 / Queues 绑定运行。

因此 `src/adapters/` 下的四个适配器（`d1-pg.ts`、`kv-pg.ts`、`r2-s3.ts`、`task-queue.ts`）是**自建形态的必需件**，把 Workers 绑定接口映射到 PG/S3。它们不是 Deno 或 Cloudflare 残留，删除会直接让生产起不来。

## 产物同步（重要）

`dist/` 不进仓库，靠构建生成。因此**每次拉代码后必须重新构建**，否则跑的是旧 bundle：

```bash
cd /opt/apps/teaven-ai/repo
git pull
npm ci
npm run build      # esbuild → dist/server.js
```

`npm run build` 在打包后还会执行 `scripts/write-build-stamp.mjs`，把当时的 `git rev-parse HEAD` 写进 `dist/BUILD_STAMP`。

`deploy/start.sh` 启动前做 fail-fast 校验：

- `dist/server.js` 不存在 → 直接退出并提示构建命令；
- 当前 `git rev-parse HEAD` 与 `dist/BUILD_STAMP` 不一致 → 直接退出，提示 `npm run build`。

即「拉了新代码但忘记构建」会立刻暴露成启动失败，而不是静默跑旧代码。

> 该校验比较的是 commit，不是文件时间戳，所以全新 clone、rsync、`git checkout` 都不会误判。代价是它发现不了服务器上的未提交改动——服务器上直接改源码本来就不属于发版流程。
>
> 校验会降级：chroot 里读不到 `git`（命令缺失），或产物是引入本机制之前构建的（无 stamp）时，只在日志里告警并放行，不会拦停服务。
>
> 拦停时 Nomad 会按 `deploy.nomad` 的 restart 策略重试 5 次（约 25 分钟）后标记失败。看到上面的错误信息，执行 `npm run build` 再 `nomad job restart teaven-ai` 即可。

## 发版流程

纪律：**stop + run**，先停旧进程再起新进程，避免两个实例同时监听 3010。

```bash
# 0. 本地先过门禁（typecheck + build）
npm run release

# 1. 服务器上：停服务
nomad job stop -purge teaven-ai

# 2. 拉代码并重建产物
cd /opt/apps/teaven-ai/repo
git pull
npm ci
npm run build

# 3. 起服务
nomad job run /opt/apps/teaven-ai/deploy/deploy.nomad

# 4. 确认健康
nomad job status teaven-ai
curl -fsS http://127.0.0.1:3010/health
```

## 本地开发

两种形态都能在本地跑：

```bash
# 走自建形态（需要本地有 PG；.env 里配 DATABASE_URL）
npm run dev:node

# 走 CF Worker 形态（用 .dev.vars，无需数据库）
cp .dev.vars.example .dev.vars
npm run dev
```

注意 `npm run dev` / `npm run dev:worker` 是 **CF Worker** 调试入口，不是生产形态；生产形态是 `npm run dev:node` 或 `npm start`。

## CF Worker 残留：哪些保留、哪些忽略

自建迁移后，仓库仍保留 Worker 形态的少量文件，全部是**有意保留**，不是待清理的死代码：

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `wrangler.toml` | 保留 | CF Worker 绑定配置，服务本地 `wrangler dev` 调试和回滚部署。只含资源标识，不含密钥。 |
| `src/index.ts` | 保留 | 共用 HTTP/Queue 入口，两种运行时都走它。 |
| `src/providers/cloudflare-workers-ai.ts` | 保留 | 该上游走 Workers AI 网关，自建形态下照常可用。 |
| `migrations/*.sql` | 保留 | D1 schema 记录；生产实际用 `migrations_pg/schema.sql`。 |
| `deploy/.env.example` 中的 `CLOUDFLARE_*` | 保留 | 供 `cloudflare-workers-ai` 插件与 R2 S3 凭证使用。 |

`.github/workflows/deploy.yml` 已于 2026-10-16 改为**手动触发**（`workflow_dispatch`）。此前它在每次推 `main` 时自动 `wrangler deploy`，会让 CF 上的旧 Worker 被不断重发，把回滚基线往前推。常规发版不要用它。

## 回滚

自建侧：Nomad job 配了 `auto_revert = true`，新版健康检查失败会自动回退到上一版本。若需手动回退，`git checkout` 到上一个提交后重新执行发版流程第 2–3 步。

CF 侧：`https://teaven-ai.moruteaven.workers.dev` 在迁移后保留 ≥7 天作为跨形态回退目标，到期后可下线；届时可删除 `wrangler.toml` 与 CF 部署 workflow。
