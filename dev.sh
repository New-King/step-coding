#!/usr/bin/env bash
# 本地开发：后端 8790 + 前端 vite 5173（热更新）
# 改 web/src 下的文件即时生效，不需要 pnpm build；改了 backend/ 由 --reload 自动重启。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "缺少 .venv：先跑 python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8790 --reload &
BACK=$!
trap 'kill "$BACK" 2>/dev/null || true' EXIT INT TERM

# 打开 http://localhost:5173 —— /api 已由 vite 代理到 8790
cd web
exec pnpm dev
