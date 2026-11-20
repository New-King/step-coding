#!/usr/bin/env bash
# 本地开发：后端 8790 + 前端 vite 5173（热更新）
# 改 web/src 下的文件即时生效，不需要 pnpm build；改了 backend/ 由 --reload 自动重启。
# Ctrl+C 会先停前端，再杀掉后端（trap 收尾）。
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "缺少 .venv：先跑 python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8790 --reload &
BACK=$!
cleanup() {
  kill "$BACK" 2>/dev/null || true
  wait "$BACK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 打开 http://localhost:5173 —— /api 已由 vite 代理到 8790
# 这里不能用 exec：exec 会替换掉当前 shell，trap 就失效了，后端会残留
cd web
pnpm dev || true
