import { defineConfig } from "@playwright/test";

/**
 * 端到端只跑「链路对不对」，不跑真实模型：
 * `/api/step` 全部由测试里 mock 成固定事件，结果确定、不花钱。
 *
 * 用本机 Chrome，不额外下载浏览器。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
