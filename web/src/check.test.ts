import { describe, expect, it } from "vitest";

import { checkFiles } from "./check";

/**
 * 自检只看确定性结构，不能靠正则瞎猜。
 * 踩过的误报：JS/CSS 里字符串或注释中的 `}` 被当成结构括号，写完却报「括号没有闭合」。
 */

describe("括号检查", () => {
  it("字符串里的括号不算结构括号", () => {
    const files = { "app.js": 'const a = "}";\nfunction f() { return a; }\n' };
    expect(checkFiles(files)).toEqual([]);
  });

  it("注释里的括号也不算", () => {
    const files = { "app.js": "// }\nfunction f() { return 1; }\n" };
    expect(checkFiles(files)).toEqual([]);
  });

  it("CSS 里 content 的括号不误判", () => {
    const files = { "style.css": '.a::after { content: "}"; }\n' };
    expect(checkFiles(files)).toEqual([]);
  });

  it("真的少一个括号还是要报", () => {
    const files = { "app.js": "function f() { return 1;\n" };
    expect(checkFiles(files).some((i) => i.text.includes("括号"))).toBe(true);
  });
});
