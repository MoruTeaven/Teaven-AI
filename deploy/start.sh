#!/bin/sh
# Teaven AI Gateway — Nomad exec 启动脚本（Node 22 + esbuild 自建版）
#
# 运行时形态：Node 22 + esbuild bundle（dist/server.js），与 Deno 无关。
#   - HTTP 入口是 src/server/node-entry.ts：用 pg / S3 适配层拼出 Worker 风格的 Env，
#     再复用 src/index.ts 的 fetch 处理全部路由。
#   - src/adapters/d1-pg.ts、kv-pg.ts、r2-s3.ts、task-queue.ts 是自建形态的必需件，
#     不是 Deno / Cloudflare 残留，不要删。
#
# 产物同步：dist/ 不进仓库，每次发版必须先构建（见 docs/deployment.md）。
# 构建时由 scripts/write-build-stamp.mjs 把当时的 git HEAD 写进 dist/BUILD_STAMP。
# 本脚本据此 fail-fast 校验，避免 git pull 后忘记构建、静默跑旧 bundle。

PROJECT_DIR=/opt/apps/teaven-ai/repo
ENV_FILE=/opt/apps/teaven-ai/.env
BUILD=dist/server.js
STAMP=dist/BUILD_STAMP

# 坑1: 补 resolv.conf（chroot 内 /etc/resolv.conf 为空，PG_HOST 域名解析会失败）
if [ ! -s /etc/resolv.conf ]; then
  printf 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n' > /etc/resolv.conf
fi

# 坑2: HOME（chroot 内以 nobody 运行，HOME 不可写）
export HOME=/tmp
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# 构建产物在 dist/server.js（esbuild bundle，git pull 后需 npm run build）
cd "$PROJECT_DIR"

# 产物缺失直接退出：提示正确的构建命令，不要退化成跑旧 bundle
if [ ! -f "$BUILD" ]; then
  echo "缺少构建产物 $BUILD：请先在 $PROJECT_DIR 执行 npm ci && npm run build" >&2
  exit 1
fi

# 产物与源码必须同一版本：git HEAD 与构建时记录的 stamp 不一致即退出。
# 常见触发场景是 git pull 之后没有重新 npm run build。
#
# 降级说明：chroot 里可能没有 git，或产物是旧版构建（无 stamp），
# 这两种情况查不到可比对的版本，只告警不拦截，避免把服务直接拦停。
HEAD=$(git rev-parse HEAD 2>/dev/null || true)
BUILT=$(cat "$STAMP" 2>/dev/null || true)

if [ -z "$HEAD" ]; then
  echo "警告：读不到 git HEAD，跳过产物版本校验（请确认本次已执行 npm run build）" >&2
elif [ -z "$BUILT" ]; then
  echo "警告：缺少 $STAMP，跳过产物版本校验（请确认本次已执行 npm run build）" >&2
elif [ "$HEAD" != "$BUILT" ]; then
  echo "构建产物与源码不一致（源码 $HEAD / 产物 $BUILT）：请先执行 npm run build 再重启" >&2
  exit 1
fi

exec node --env-file="$ENV_FILE" "$BUILD"