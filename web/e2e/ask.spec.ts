import { expect, test } from "@playwright/test";

/**
 * 追问作答的两条边界。
 *
 * 1. 只能在卡片里回答：卡片开着时从底部输入框说话，等于「这组问题先不答」，
 *    卡片要撤掉、这句话按新指令走——不能把它当成第一题的答案。
 * 2. 答完之后锁要放开：踩过的 bug 是答完最后一题 `answeringRef` 没复位，
 *    下一次追问的答案被静默吞掉（输入框清空，卡片不动）。
 *
 * `/api/step` 全部 mock 成固定事件，不调模型、不花钱。
 */

test("卡片开着时从底部说话不算回答，且下次追问还能答", async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        id: "e2e-ask",
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
    const body = route.request().postDataJSON() as { seq: number; message?: string | null };
    const seq = body.seq;

    if (seq === 0) {
      await route.fulfill({
        json: {
          event: {
            action: "ask",
            questions: [
              { question: "要写哪个函数？", options: ["字符串工具", "数字工具"] },
              { question: "叫什么名字？", options: [] },
            ],
          },
          seq: 1,
          changed: {},
          stop: true,
        },
      });
      return;
    }

    if (seq === 1) {
      await route.fulfill({
        json: {
          event: {
            action: "ask",
            questions: [{ question: "要加测试吗？", options: ["要", "不要"] }],
          },
          seq: 2,
          changed: {},
          stop: true,
        },
      });
      return;
    }

    await route.fulfill({
      json: { event: { action: "say", text: "好，开始写。" }, seq: seq + 1, changed: {}, stop: true },
    });
  });

  await page.goto("/");
  await page.fill("textarea", "写个小函数配上单元测试");
  await page.keyboard.press("Enter");

  // 多题卡片：问题 1/2
  await expect(page.locator(".ask-progress")).toHaveText(/问题 1\/2/, { timeout: 20_000 });

  // 从底部输入框说话：卡片要被撤掉，不能推进成「问题 2/2」
  await page.fill("textarea", "先别问，直接写");
  await page.keyboard.press("Enter");

  await expect(page.locator(".chat-log")).toContainText("先别问，直接写", { timeout: 10_000 });
  // 下一张卡片是模型重新问的那个（单题，不再有 1/2 的进度条）
  await expect(page.locator(".ask-q")).toHaveText("要加测试吗？", { timeout: 15_000 });
  await expect(page.locator(".ask-progress")).toHaveCount(0);

  // 这一答必须生效（上一轮锁没放开的 bug 会卡在这里）
  await page.fill(".ask-input-row input", "要");
  await page.keyboard.press("Enter");

  await expect(page.locator(".ask-card")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".chat-log")).toContainText("好，开始写", { timeout: 15_000 });
});
