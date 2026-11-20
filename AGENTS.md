# 约定

## 本地预览用 dev server（热更新，不要每次 build）

```bash
./dev.sh      # 后端 8790（--reload）+ 前端 vite 5173，改 web/src 即时生效
```

打开 <http://localhost:5173>，`/api` 已代理到 8790。改 `web/src/` 任何文件都不用构建。

只有两种情况才 `cd web && pnpm build`：

- 要看「后端自己发前端」的线上形态（8790 单进程）
- 需要 `dist` 产物（静态预览）

线上不用手动 build：GitHub Actions 里已经有 `pnpm build`。

## 不主动提交、不主动推送

改完只留在工作区，等用户看完效果、明确说「提交 / 推送」再动。线上部署由 GitHub Actions 触发，一 push 就直接上生产。

## 部署形态（别再猜）

- 代码：`/opt/step-coding`（rsync 覆盖，服务器上没有 `.git`）
- 进程：systemd `step-coding`，`uvicorn backend.main:app --host 127.0.0.1 --port 8790`，单 worker
- 入口：1Panel 站点 `stepcoding.new-king.com` 整站反代到 8790，OpenResty 跑在容器里（改配置要 `docker exec <容器> openresty -s reload`）
- 自动部署：`.github/workflows/deploy.yml`，push main → 构建 → rsync → 重启

## 别动的东西

- 服务器的 `YJ-FIREWALL-INPUT` 链是自动防爆破在写，改之前先确认来源，别整条清空。
