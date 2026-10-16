# 部署手册

本文档描述 **现行生产形态**（自建 Node 22 + esbuild）。⚠️ 这不是终态——目标运行时已定为 **celld / workerd**，详见下文「运行时路线：现状与目标」。

本项目历史上是 Cloudflare Workers 项目，仓库里仍保留若干 Worker 形态资产，本文档先说清现状，再列出哪些是保留的、哪些是过渡期专属。

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

# 走 CF Worker / celld 形态（用 .dev.vars，无需数据库）
cp .dev.vars.example .dev.vars
npm run dev
```

注意 `npm run dev` / `npm run dev:worker` 是 **Worker 形态**调试入口（底层是 wrangler + workerd），不是当前生产形态；当前生产是 `npm run dev:node` 或 `npm start`。迁 celld 后，生产入口将是 `celld deploy`（配置读 `wrangler.json`）。

## 运行时路线：现状与目标

> ⚠️ **本文档描述的是「当前生产」，不是最终形态。**

| | 运行时 | 状态 |
| --- | --- | --- |
| **当前生产** | Node 22 + esbuild（Nomad exec，端口 3010） | ✅ 在跑 |
| **过渡/回滚** | Cloudflare Workers（`workers.dev`） | ✅ 在跑，手动部署 |
| **目标形态** | **celld / workerd**（Workers 编程模型） | ⏳ 已定版，未开始 |

**2026-10-12 已定版**：目标运行时采用 celld/workerd，**不走 Node LTS 路线**。本项目是 9 个服务里**第一个**迁 celld 的目标（排序：teaven-ai → removebg-api → teaven-express-api → 其余 6 个）。

因此当前这个 Node 形态是**过渡态**，不要把它当终态来优化。迁移前置条件是 celld 侧的 PoC（见总规划卡 `t-mv3rw4ad-a0630b` 与评估卡 `t-mv3ulbev-sq9ru3`）。

### celld 路线不会推翻什么

这一点容易搞反，先说清楚：

| 组件 | celld 路线下 |
| --- | --- |
| **PostgreSQL + Patroni** | ✅ **完全保留**。celld 无 PG 支持，走 postgres.js 直连 |
| **HAProxy :6432** | ✅ **必须保留**。celld 官方 compat 表 **Hyperdrive = No**（无连接池），反而更需要它 |
| **EdgeOne / Nginx** | ✅ 保留。celld 不终结 TLS |
| `src/adapters/d1-pg.ts` 等适配器 | ✅ **保留**。celld 替代的是「平台适配层」，不是「数据库适配层」 |

> 曾有一种误解是「迁 celld 要把数据从 PG 搬回 D1」。**不成立**——PG 是目标库，从头到尾不迁。

## 配置格式：wrangler.json

2026-10-16 已把 `wrangler.toml` 转换为 `wrangler.json`。原因是 celld 官方 `docs/cloudflare-compat.md` 明确：

> `celld deploy` accepts `wrangler.jsonc` or `wrangler.json`, **not `wrangler.toml`**.

celld 只接受以下顶层键，多一个就拒绝部署（含 `routes`）：

```
$schema  name  main  no_bundle
compatibility_date  compatibility_flags
durable_objects  migrations
assets  services  triggers  vars
d1_databases  kv_namespaces  queues  workflows  r2_buckets
worker_loaders  containers  define  rules
```

⚠️ 转换时被**移除**的是 `observability`（logs/traces 采样）——它不在上述白名单内，照搬会导致 celld 部署被拒。代价是 CF 侧的日志采样配置丢失；考虑到 CF Worker 已是手动部署的回滚通道，可接受。

⚠️ wrangler 4 在 `wrangler.toml` 与 `wrangler.json` **并存**时会静默优先读 JSON 且**不告警**（已实测：向 JSON 注入探针变量生效，TOML 无任何提示）。所以只保留 JSON，不要把 TOML 加回来。

### celld 形态：代码已就绪（2026-10-16）

`src/server/celld-entry.ts` 已实现并通过打包校验。与 `node-entry.ts` 的差别只有「东西从哪来」，业务逻辑（`src/index.ts` 及全部路由）完全共用。

| | Node 自建（当前生产） | celld（迁移目标） |
| --- | --- | --- |
| 入口 | `src/server/node-entry.ts` | `src/server/celld-entry.ts` |
| PG 驱动 | node-postgres（`pg`） | **postgres.js**（`postgres`） |
| FILES | `r2-s3.ts` + `@aws-sdk/client-s3` | celld 原生 R2 绑定 |
| 组装 | 共用 `src/server/env-factory.ts` | 同左 |

**为什么必须换掉 `pg`**：celld 的 Node 兼容是 **Partial**，只实现 `node:assert` / `async_hooks` / `buffer` / `diagnostics_channel` / `events` / `fs` / `os` / `path` / `stream` / `timers/promises` / `util`，**没有 `node:net` 与 `node:tls`**——而 `pg` 正是靠这两个建连接。postgres.js 的包 exports 带 `"workerd": "./cf/src/index.js"` 条件导出，该构建用 polyfill 把 `net.Socket` / `tls.connect` 换成 Workers 原生 TCP socket。

因此新增了 `src/adapters/sql.ts` 的 `SqlExecutor` 最小接口：`d1-pg.ts` / `kv-pg.ts` / `task-queue.ts` 只依赖它，换驱动时一行不用改（`sql.unsafe(text, args)` 的签名与 `pool.query(text, values)` 对齐）。

**定时轮询的坑**：Worker isolate 随时可能被回收，`setInterval` 不保证存活。因此 `task-queue.ts` 把单次扫描抽成 `pollTaskQueue()` 导出，celld 侧由 `scheduled` handler 驱动（配 `wrangler.json` 的 `triggers.crons`），不依赖常驻定时器。

### 校验方式

```bash
npm run check:celld    # wrangler deploy --dry-run --config wrangler.celld-check.jsonc
```

`wrangler.celld-check.jsonc` 只是**打包校验用**，不是部署配置。它验证 `celld-entry.ts` 能否在 Workers 运行时打包成功——尤其是 `node:net` / `node:tls` 有没有被意外引入。

已实测产物 `764.90 KiB / gzip 160.15 KiB`，且包内：

| 检查 | 结果 |
| --- | --- |
| 用 postgres.js 的 workerd 构建（polyfills 垫片） | ✅ 在 |
| `node:net` / `node:tls` | ✅ 不在 |
| `@aws-sdk/client-s3` | ✅ 不在（FILES 走原生 R2 绑定） |
| node-postgres | ✅ 不在 |

### 切到 celld 还要做的事

1. **改 `main`**：`wrangler.json` 的 `main` 从 `src/index.ts` 改成 `src/server/celld-entry.ts`（celld 只读 wrangler.json/jsonc）。
2. **PG 凭据走 secret**：`PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` 全部走 celld secret，**绝不能写进 wrangler.json**（PoC 阶段曾明文写过，是已知遗留问题）。
3. **FILES 存储归属待定案**：换成 celld 原生 R2 绑定后，业务文件会落到 celld 的对象存储，而不是当前的 Cloudflare R2。**存量文件如何迁移、是否接受这个变更，需先定案**——这是本项目迁 celld 最大的未决问题。
4. **轮询间隔对齐**：`triggers.crons` 最细只能到 1 分钟，而 Node 形态的 `POLL_INTERVAL_MS` 是 5 秒。上线前需确认 1 分钟对任务时效是否够（异步媒体任务通常够，但需实测）。
5. **celld 侧前置条件**（不属本仓库）：降权运行（现以 root 跑、CapEff 41 项全开无 Seccomp）、`CELLD_MAX_RSS_MB` 必须显式设、Nginx 反代（现仅监听 127.0.0.1）、SeaweedFS 完整 `celld diagnose`。详见评估卡 `t-mv3ulbev-sq9ru3`。

## CF Worker 残留：哪些保留、哪些忽略

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `wrangler.json` | 保留 | 绑定配置，服务本地 `wrangler dev` 调试、回滚部署，以及未来的 celld 部署。 |
| `wrangler.celld-check.jsonc` | 保留 | 仅供 `npm run check:celld` 做 celld 打包校验，不是部署配置。 |
| `src/index.ts` | 保留 | 共用 HTTP/Queue 入口，CF Worker 直接跑它；celld 经 `celld-entry.ts` 转交。 |
| `src/server/node-entry.ts` | 过渡期 | Node 自建入口；迁 celld 后由 `celld-entry.ts` 取代。 |
| `src/adapters/sql.ts` | 保留 | PG 驱动抽象，让同一套适配层同时支持 node-postgres 与 postgres.js。 |
| `src/providers/cloudflare-workers-ai.ts` | 保留 | 该上游走 Workers AI 网关，自建形态下照常可用。 |
| `migrations/*.sql` | 保留 | D1 schema 记录；生产实际用 `migrations_pg/schema.sql`。 |
| `deploy/.env.example` 中的 `CLOUDFLARE_*` | 保留 | 供 `cloudflare-workers-ai` 插件与 R2 S3 凭证使用。 |

`.github/workflows/deploy.yml` 已于 2026-10-16 改为**手动触发**（`workflow_dispatch`）。此前它在每次推 `main` 时自动 `wrangler deploy`，会让 CF 上的旧 Worker 被不断重发，把回滚基线往前推。常规发版不要用它。

## 回滚

自建侧：Nomad job 配了 `auto_revert = true`，新版健康检查失败会自动回退到上一版本。若需手动回退，`git checkout` 到上一个提交后重新执行发版流程第 2–3 步。

CF 侧：`https://teaven-ai.moruteaven.workers.dev` 在迁移后保留 ≥7 天作为跨形态回退目标，到期后可下线；届时可删除 CF 部署 workflow 与 `wrangler.json` 中的 CF 专属绑定 ID。
