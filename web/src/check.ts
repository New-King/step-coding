/**
 * 写完之后的检查。确定性判断，不调模型——
 * 这种事交给模型反而会漏，正则扫一遍更快也更准。
 */

export type Issue = { file: string; text: string };

function refsInHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link[^>]*href=["']([^"']+\.css)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/<script[^>]*src=["']([^"']+\.js)["']/gi)) out.push(m[1]);
  return out;
}

function classesInHtml(html: string): Set<string> {
  const set = new Set<string>();
  for (const m of html.matchAll(/class=["']([^"']+)["']/gi)) {
    for (const c of m[1].split(/\s+/)) if (c) set.add(c);
  }
  return set;
}

function classesInCss(css: string): Set<string> {
  const set = new Set<string>();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) set.add(m[1]);
  return set;
}

function idsInHtml(html: string): Set<string> {
  const set = new Set<string>();
  for (const m of html.matchAll(/id=["']([^"']+)["']/gi)) set.add(m[1]);
  return set;
}

function idsUsedInJs(js: string): Set<string> {
  const set = new Set<string>();
  for (const m of js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) set.add(m[1]);
  for (const m of js.matchAll(/querySelector\(\s*["']#([\w-]+)["']\s*\)/g)) set.add(m[1]);
  return set;
}

function balanced(code: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export function checkFiles(files: Record<string, string>): Issue[] {
  const issues: Issue[] = [];
  const paths = Object.keys(files);

  for (const path of paths) {
    if (!files[path].trim()) {
      issues.push({ file: path, text: "还是空的，没有写出内容" });
    }
  }

  const htmlPath = paths.find((p) => p.endsWith(".html"));
  const cssPath = paths.find((p) => p.endsWith(".css"));
  const jsPath = paths.find((p) => p.endsWith(".js"));
  const html = htmlPath ? files[htmlPath] : "";
  const css = cssPath ? files[cssPath] : "";
  const js = jsPath ? files[jsPath] : "";

  // HTML 引用的样式/脚本，包里有吗
  if (htmlPath) {
    for (const ref of refsInHtml(html)) {
      const hit = paths.some((p) => p === ref || p.endsWith(`/${ref}`));
      if (!hit) {
        issues.push({ file: htmlPath, text: `引用了 ${ref}，但没有这个文件` });
      }
    }
    if (cssPath && !html.includes(cssPath.split("/").pop() ?? "")) {
      issues.push({ file: cssPath, text: "写出来了，但 HTML 里没引用它" });
    }
  }

  // HTML 用到的类名，CSS 里有没有
  if (htmlPath && cssPath && css.trim()) {
    const used = classesInHtml(html);
    const defined = classesInCss(css);
    const missing = [...used].filter((c) => !defined.has(c));
    if (missing.length) {
      issues.push({
        file: cssPath,
        text: `这些类名在 HTML 里用到，但 CSS 没写到：${missing.slice(0, 4).join("、")}`,
      });
    }
  }

  // JS 找的元素，HTML 里有吗
  if (jsPath && htmlPath && js.trim()) {
    const ids = idsInHtml(html);
    const missing = [...idsUsedInJs(js)].filter((id) => !ids.has(id));
    if (missing.length) {
      issues.push({
        file: jsPath,
        text: `脚本在找 #${missing.slice(0, 3).join("、#")}，HTML 里没有这个 id`,
      });
    }
  }

  // 括号成不成对
  if (cssPath && css.trim() && !balanced(css, "{", "}")) {
    issues.push({ file: cssPath, text: "花括号没有闭合，后面会全乱" });
  }
  if (jsPath && js.trim() && !(balanced(js, "{", "}") && balanced(js, "(", ")"))) {
    issues.push({ file: jsPath, text: "括号没有闭合" });
  }

  return issues;
}

export function summarize(files: Record<string, string>): string {
  const paths = Object.keys(files).filter((p) => files[p].trim());
  const lines = paths.reduce((n, p) => n + files[p].split("\n").length - 1, 0);
  return `${paths.length} 个文件，${lines} 行`;
}