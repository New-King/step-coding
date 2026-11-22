import { expect, test } from "@playwright/test";

/**
 * 插话的边界。
 *
 * 踩过两次的 bug：正在写文件时插话，代码区不但继续写，还把整份内容一次补出来。
 * 根因在 App.tsx 的调用层（`send` / `pump`），单测测不到，只能从这里兜。
 *
 * `/api/step` 全部 mock 成固定事件，结果确定、不花钱：
 *   seq 0 → index.html（短，立刻演完）
 *   seq 1 → style.css（短，立刻演完）
 *   seq 2 → app.js（长，演到一半时测试插话）
 *   seq 3 → vendor.js（长）—— 插话前发出的那一次请求，回来时必须是 stale
 *   seq 4 → say「停住了」
 *
 * 关键时序：插话必须落在 seq 3 在途的窗口里，这样它回来时才是「旧请求」，
 * 修复版丢弃它，回归版会把它演出来（`code-path` 变成 vendor.js）。
 */

const LONG = Array.from({ length: 150 }, (_, i) => `const f${i} = () => ${i};`).join("\n");

test("插话后不再演旧请求的写动作", async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        id: "e2e",
        seq: 0,
        files: {},
        messages: [],
        last_event: null,
        last_stop: false,
        restored: true,
      },
    })
  );

  await page.route("**/api/log", (route) => route.fulfill({ json: { ok: true } }));

  await page.route("**/api/step", async (route) => {
    const body = route.request().postDataJSON() as { seq: number };
    const seq = body.seq;
    // 网络往返：给插话留出窗口
    await new Promise((r) => setTimeout(r, 800));

    if (seq === 0) {
      await route.fulfill({
        json: {
          event: { action: "write", path: "index.html", code: "<h1>hi</h1>", label: "写 index.html" },
          seq: 1,
          changed: { "index.html": "<h1>hi</h1>" },
          stop: false,
        },
      });
      return;
    }

    if (seq === 1) {
      await route.fulfill({
        json: {
          event: { action: "write", path: "style.css", code: ".a { color: #123; }", label: "写 style.css" },
          seq: 2,
          changed: { "style.css": ".a { color: #123; }" },
          stop: false,
        },
      });
      return;
    }

    if (seq === 2) {
      await route.fulfill({
        json: {
          event: { action: "write", path: "app.js", code: LONG, label: "写 app.js" },
          seq: 3,
          changed: { "app.js": LONG },
          stop: false,
        },
      });
      return;
    }

    if (seq === 3) {
      // 插话前发出的那一步：必须被丢弃
      await route.fulfill({
        json: {
          event: { action: "write", path: "vendor.js", code: LONG, label: "写 vendor.js" },
          seq: 4,
          changed: { "vendor.js": LONG },
          stop: false,
        },
      });
      return;
    }

    await route.fulfill({
      json: { event: { action: "say", text: "停住了" }, seq: seq + 1, changed: {}, stop: true },
    });
  });

  await page.goto("/");
  await page.fill("textarea", "做个页面");
  await page.keyboard.press("Enter");

  // 等到 app.js 开始逐字（此时 seq 3 的请求已经在路上）
  await expect(page.locator(".code-path")).toHaveText("app.js", { timeout: 20_000 });
  await expect(page.locator(".file-coding")).toBeVisible({ timeout: 20_000 });

  const code = page.locator(".code");
  const before = ((await code.textContent()) ?? "").length;

  // 插话
  await page.fill("textarea", "等下");
  await page.keyboard.press("Enter");

  // 旧请求（vendor.js）不许被演出来：不出现「正在写」，也不许切走当前文件
  await expect(page.locator(".file-coding")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".code-path")).toHaveText("app.js");

  const after = ((await code.textContent()) ?? "").length;
  await page.waitForTimeout(1500);
  const later = ((await code.textContent()) ?? "").length;

  expect(later).toBe(after);
  // 插话瞬间最多再多出几个字，不能整份补出来
  expect(later - before).toBeLessThan(LONG.length / 4);

  // 收尾交回给带新指令的那一轮，而且只能有一句（多出来就是循环补跑了）
  await expect(page.locator(".status")).toHaveText(/已完成/, { timeout: 15_000 });
  await expect(page.locator(".tl.say")).toHaveCount(1);
  await expect(page.locator(".tl.say")).toContainText("停住了");
});
