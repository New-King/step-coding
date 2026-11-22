import { defineConfig } from "vitest/config";

/** 单测只跑 src 下的 `*.test.ts`；`e2e/` 归 playwright，两个 runner 不能互相收。 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
