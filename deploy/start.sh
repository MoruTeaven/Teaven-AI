#!/bin/sh
# Teaven AI Gateway — Nomad exec 启动脚本（Node 22 自建版）
# 适配自 deploy/templates/start.sh，把 Deno 换成 Node + esbuild 产物。

PROJECT_DIR=/opt/apps/teaven-ai/repo
ENV_FILE=/opt/apps/teaven-ai/.env

# 坑1: 补 resolv.conf（chroot 内 /etc/resolv.conf 为空，PG_HOST 域名解析会失败）
if [ ! -s /etc/resolv.conf ]; then
  printf 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n' > /etc/resolv.conf
fi

# 坑2: HOME（chroot 内以 nobody 运行，HOME 不可写）
export HOME=/tmp
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# 构建产物在 dist/server.js（esbuild bundle，git pull 后需 npm run build）
cd "$PROJECT_DIR"
exec node --env-file="$ENV_FILE" dist/server.js