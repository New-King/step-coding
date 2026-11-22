import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Player, type Plan } from "./player";

/**
 * 播放器的行为回归。
 *
 * 这几条都是实际踩过的坑，改 `player.ts` / `send()` 之前先跑一遍：
 *   1. 速度只认 cps（曾有按文件长度偷偷加速，滑杆调不动）
 *   2. 插话用 holdTyping 停在半截（用 settle 会把整份代码补出来）
 *   3. stop 之后不再增长、busy 为假（否则下一次动作永远排队）
 *   4. edit 在「改之前」的内容上逐字替换
 */

function plan(code: string, path = "a.js"): Plan {
  return {
    task: "t",
    steps: [{ type: "create", path, code, banner: "写文件", delay: 0 }],
    files: { [path]: "" },
    stats: { files: 1, steps: 1, lines: 0 },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("速度", () => {
  it("打字速度由 cps 决定，长文件不会自己加速", () => {
    const code = "x".repeat(4000);

    const slow = new Player();
    slow.cps = 30;
    slow.load(plan(code));
    vi.advanceTimersByTime(1000);
    const slowLen = slow.files()["a.js"].length;
    slow.stop();

    const fast = new Player();
    fast.cps = 120;
    fast.load(plan(code));
    vi.advanceTimersByTime(1000);
    const fastLen = fast.files()["a.js"].length;
    fast.stop();

    // 一秒内都打不完，否则说明又偷偷提速了
    expect(slowLen).toBeGreaterThan(5);
    expect(fastLen).toBeLessThan(code.length);
    expect(fastLen).toBeGreaterThan(slowLen * 2);
  });
});

describe("插话收手", () => {
  it("holdTyping 停在演到的位置，不把剩下的字补出来", () => {
    const p = new Player();
    p.cps = 60;
    p.load(plan("y".repeat(2000)));
    vi.advanceTimersByTime(500);

    const mid = p.files()["a.js"].length;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(2000);

    p.holdTyping();
    expect(p.files()["a.js"].length).toBe(mid);
    expect(p.busy).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(p.files()["a.js"].length).toBe(mid);
  });

  it("holdTyping 之后推入新动作还能正常开演（不会卡在排队）", () => {
    const p = new Player();
    p.cps = 60;
    p.load(plan("w".repeat(2000)));
    vi.advanceTimersByTime(300);
    p.holdTyping();

    p.push([{ type: "create", path: "b.js", code: "next", banner: "写 b.js", delay: 0 }]);
    vi.advanceTimersByTime(300);
    expect(p.files()["b.js"]).toBe("next");
  });
});

describe("edit", () => {
  it("按改之前的内容找到原文，逐字替换", () => {
    const p = new Player();
    p.cps = 60;
    p.load({
      task: "t",
      steps: [{ type: "edit", path: "a.js", find: "OLD", replace: "NEWNEW", banner: "改" }],
      files: { "a.js": "a OLD b" },
      initial: { "a.js": "a OLD b" },
      stats: { files: 1, steps: 1, lines: 0 },
    });

    // 开演前原文还在
    expect(p.files()["a.js"]).toBe("a OLD b");
    vi.advanceTimersByTime(600);
    expect(p.files()["a.js"]).toBe("a NEWNEW b");
  });
});
