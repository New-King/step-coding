export type Step =
  | { type: "create"; path: string; code: string; banner: string; delay?: number }
  | { type: "append"; path: string; code: string; banner: string }
  | { type: "edit"; path: string; find: string; replace: string; banner: string }
  | { type: "delete"; path: string; banner: string; delay?: number }
  | { type: "banner"; text: string; delay?: number }
  | { type: "done"; text: string; delay?: number };

export type Plan = {
  task: string;
  steps: Step[];
  files: Record<string, string>;
  stats: { files: number; steps: number; lines: number };
  /** 已有的缓冲区：增量修改时，没动的文件保留原内容 */
  initial?: Record<string, string>;
};

/**
 * 打字速度只由滑杆的 `cps`（每秒字符数）决定，不再按文件长度偷偷提速。
 *
 * 早先给单个文件设了 8 秒上限，长文件会被强制加速，于是滑杆调多慢都一个样。
 * 现在慢就是慢：1500 字的文件在 60 cps 下约 25 秒，想快自己把滑杆推上去。
 */

/** 正在演的动作：状态行要跟它，不能跟新到的事件（否则右边说 css、左边还在打 html） */
export type PlayMode = "create" | "append" | "edit" | "delete" | null;

export type Snapshot = {
  buffers: Record<string, string>;
  active: string | null;
  /** 正在演删除的文件：还在列表里淡出，过一会儿才真的拿掉 */
  removing: string | null;
  mode: PlayMode;
  banner: string;
  /** 打字打到的这一小块在干什么（最近的注释 / 函数 / 选择器），没有就是空串 */
  hint: string;
  say: string;
  stepIndex: number;
  total: number;
  typing: boolean;
  finished: boolean;
};

/**
 * 打了一半的那段字。
 *
 * 播放器只把「已经摆出来的内容」和「还没打的字」分开记：暂停 / 刷新时存下这一份，
 * 回来摆回半截再接着打；`at` 是剩余部分要插进去的位置（改代码时是中间某处，不是末尾）。
 */
export type Typing = {
  path: string;
  shown: string;
  rest: string;
  at: number;
  banner: string;
};

/** 往回最多找这么多行，再往前就不是"这一块"了 */
const HINT_LINES = 60;
/** 提示别太长，右上角浮层就那么宽，再长就截掉 */
const HINT_MAX = 12;

const COMMENT_LINE = /^(?:\/\/|#|--|\/\*|\*|<!--)\s*(.+?)\s*(?:\*\/|-->)?$/;
const FN_LINE = /^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/;
const HANDLE_LINE = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\()/;
const CLASS_LINE = /^(?:export\s+)?(?:class|interface|struct|type)\s+([\w$]+)/;
const TAG_LINE = /^<([a-z][\w-]*)([^>]*)>/;
const CLOSE_TAG = /^<\/([a-z][\w-]*)/;
/** 这些标签只是页面骨架，说了也不说明在干嘛，跳过 */
const STRUCTURAL_TAGS = new Set(["html", "head", "body", "meta", "link", "title", "base"]);
/**
 * 样式规则的行首。
 *
 * 除了 `.card` / `#app`，也认 `body {` 这种元素选择器——但有白名单，
 * 否则 JS 里的 `if (x) {`、`for (...) {` 会被当成样式规则。
 */
const CSS_LINE = new RegExp(
  `^([.#][\\w-][^{]*|(?:${[
    "html", "body", "main", "header", "footer", "nav", "section", "article", "aside",
    "div", "form", "label", "input", "textarea", "select", "option", "button", "a",
    "ul", "ol", "li", "table", "tr", "td", "th", "img", "canvas", "svg", "h1", "h2",
    "h3", "h4", "p", "span", "style", "script",
  ].join("|")}))\\s*\\{`
);

function clip(text: string, max = HINT_MAX) {
  if (text.length <= max) return text;
  // 截断处别留半句标点
  return `${text.slice(0, max).replace(/[，。；、,.;:：\s]+$/, "")}…`;
}

/** 块级容器：它们包着的内容算同一个板块（导航、登录表单、卡片…） */
const CONTAINER_TAGS = new Set([
  "html", "body", "header", "footer", "nav", "main", "section", "article", "aside",
  "div", "form", "fieldset", "table", "thead", "tbody", "ul", "ol", "dl", "dialog", "figure",
]);

/**
 * 元素说人话。
 *
 * 浮层不能出现「正在写 <a>」「正在写 <style>」——用户不知道那是干什么的。
 * 这里把标签翻成中文名，再用所属板块拼起来：「正在写导航里的链接」。
 */
const ELEMENT_NAMES: Record<string, string> = {
  body: "页面", div: "容器", section: "区块", header: "页头", footer: "页脚", nav: "导航",
  main: "主区域", aside: "侧栏", article: "文章块", form: "表单", fieldset: "表单组",
  label: "标签", input: "输入框", textarea: "文本域", select: "下拉框", option: "选项",
  button: "按钮", a: "链接", ul: "列表", ol: "列表", li: "列表项", dl: "说明列表",
  table: "表格", thead: "表头", tbody: "表格主体", tr: "表格行", td: "单元格", th: "表头格",
  img: "图片", svg: "图标", canvas: "画布", video: "视频", audio: "音频",
  h1: "大标题", h2: "标题", h3: "小标题", h4: "小标题", p: "段落", span: "文字",
  strong: "强调文字", em: "强调文字",
  style: "样式", script: "脚本", link: "外部资源", meta: "页面信息", title: "页面标题",
};

/** 常见类名词 → 中文：`.card` 说成「卡片」，比「.card 的样式」像人话 */
const CLASS_WORDS: Record<string, string> = {
  card: "卡片", header: "页头", footer: "页脚", nav: "导航", navbar: "导航",
  form: "表单", input: "输入框", button: "按钮", btn: "按钮", list: "列表",
  item: "条目", items: "条目", title: "标题", text: "文字", modal: "弹窗",
  dialog: "弹窗", sidebar: "侧栏", container: "容器", wrapper: "容器", wrap: "容器",
  row: "行", col: "列", column: "列", avatar: "头像", badge: "徽标", tab: "标签页",
  menu: "菜单", dropdown: "下拉", toast: "提示", alert: "警告", hero: "首屏",
  banner: "横幅", logo: "标志", icon: "图标", loading: "加载提示", spinner: "加载提示",
  table: "表格", grid: "网格", panel: "面板", toolbar: "工具栏", search: "搜索框",
  login: "登录", signup: "注册", profile: "个人资料", chat: "对话", message: "消息",
  game: "游戏", canvas: "画布", score: "分数", board: "面板", cell: "格子",
  bar: "栏", top: "顶部", bottom: "底部", content: "内容", info: "信息",
  desc: "说明", field: "字段", group: "分组", actions: "操作区", progress: "进度",
  label: "标签", tags: "标签", value: "数值", status: "状态", empty: "空状态",
};

/** 这些标签自己说不出用途，板块名要靠类名 */
const GENERIC_TAGS = new Set(["div", "section", "article", "aside", "main", "span"]);

const CHINESE = /^[\u4e00-\u9fa5]+$/;

/**
 * 类名说人话：`.login-card` → 「登录 卡片」，`.card` → 「卡片」。
 * 认不出来的词原样保留（宁可中英混排，也不要瞎翻）。
 */
function classWords(name: string) {
  const parts = name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => CLASS_WORDS[w.toLowerCase()] ?? w);
  if (!parts.length) return name;
  return parts.every((p) => CHINESE.test(p)) ? parts.join("") : parts.join(" ");
}

/** `.row input[type="text"]` → `.row`：只说这条规则管哪一块，别把整串选择器塞进浮层 */
function cssHead(sel: string) {
  const head = sel.trim().split(/[\s>+~]+/)[0].split(/[:\[]/)[0];
  return head || sel.trim();
}

/**
 * 注释里能当"这一块叫什么"的那部分。
 *
 * 生成出来的代码里常有 `/* { margin: 0 } *\/`、`// ---- 分隔 ----` 这类注释，
 * 原样拿去当标题会变成「正在写『{ margin…』」，等于没说。
 * 先去掉首尾的装饰符号；剩下仍以代码符号开头或结尾的，多半是注释掉的代码，跳过。
 */
function commentText(raw: string) {
  const text = raw
    .replace(/^[\s\-=*#/>]+/, "")
    .replace(/[\s\-=*#/<]+$/, "")
    .trim();
  if (text.length < 2) return "";
  if (/^[{}()[\];,.<>]/.test(text) || /[{}();,<>=]$/.test(text)) return "";
  return text;
}

/** 往上找最近的注释：它就是这一块的名字（生成出来的代码基本每块都有注释） */
function commentAbove(lines: string[], start: number, from: number) {
  for (let i = start - 1; i >= from; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const comment = COMMENT_LINE.exec(line);
    if (!comment?.[1]) continue;
    const name = commentText(comment[1]);
    if (name) return `「${clip(name, 10)}」`;
  }
  return "";
}

/**
 * 这一段属于哪个板块：往上找最近的注释或块级容器。
 *
 * 要认层级：往回扫时先记下遇到的 `</div>`，遇到对应的 `<div>` 就把它划掉——
 * 已经闭合的容器不算，注释也只在还没跨出任何闭合标签时才算。
 * 否则「分数面板」那条注释会一直粘到后面的 canvas / button 上（它们其实在 main 里）。
 */
function blockAbove(lines: string[], start: number, from: number) {
  const closed = new Set<string>();
  /** 已经跨出过一层容器：更上面的注释就不属于这里了 */
  let crossed = false;
  let container = "";

  for (let i = start - 1; i >= from; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const close = CLOSE_TAG.exec(line);
    if (close) {
      closed.add(close[1]);
      continue;
    }

    const tag = TAG_LINE.exec(line);
    if (tag) {
      if (STRUCTURAL_TAGS.has(tag[1])) continue;
      if (closed.has(tag[1])) {
        // 这是上面某个容器的结束标签，跨出去了
        closed.delete(tag[1]);
        crossed = true;
        continue;
      }
      if (closed.size > 0 || !CONTAINER_TAGS.has(tag[1]) || container) continue;
      // div / section 这类本身不说明用途，用类名（div.card → 卡片）；
      // nav / header / form 本身就有名字，别被 class="top" 抢走（否则变成「顶部里的链接」）
      const cls = /class="([^"]+)"/.exec(tag[2])?.[1]?.trim().split(/\s+/)[0];
      const named = cls ? classWords(cls) : "";
      if (GENERIC_TAGS.has(tag[1]) && named && CHINESE.test(named)) container = named;
      else container = ELEMENT_NAMES[tag[1]] ?? tag[1];
      continue;
    }

    if (crossed) continue;
    const comment = COMMENT_LINE.exec(line);
    const name = comment?.[1] ? commentText(comment[1]) : "";
    // 注释比容器更近、且还没跨出容器，才算这一块的名字
    if (name) return `「${clip(name, 10)}」`;
  }
  return container;
}

/**
 * 正在打字的这一段是干什么的？
 *
 * 规则：先看最靠近光标的动作线索（注释 / 函数 / 类 / 样式选择器 / 标签），
 * 再补一句它属于哪个板块——注释优先，其次外层容器。
 * 于是输出是「「登录表单」里的标签」「导航里的链接」「login-card 的样式」，
 * 而不是「<label>」「<a>」「.card」这种只有程序看得懂的东西。
 *
 * 返回的是短语，不带"正在写"——前缀由界面拼，两边都加会变成「正在写 正在写 …」。
 */
export function sectionAt(text: string, at: number): string {
  const lines = text.slice(0, at).split("\n");
  const from = Math.max(0, lines.length - HINT_LINES);
  // 从倒数第二行看：最后一行还在敲，读它会出现"登录表"这种半截词
  for (let i = lines.length - 2; i >= from; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;

    // 正好在写某条注释：它就是这块的名字，用引号括起来
    const comment = COMMENT_LINE.exec(line);
    if (comment?.[1]) {
      const name = commentText(comment[1]);
      if (name) return `「${clip(name, 10)}」`;
    }

    // 函数 / 类 / 变量：说明在实现哪个功能
    const fn = FN_LINE.exec(line);
    if (fn) return `${clip(fn[1], 12)}() 方法`;

    const handle = HANDLE_LINE.exec(line);
    if (handle) return `${clip(handle[1], 12)} 的逻辑`;

    const cls = CLASS_LINE.exec(line);
    if (cls) return `${clip(cls[1], 12)} 类`;

    // 样式：说清是谁的样式，别只丢一个类名
    const css = CSS_LINE.exec(line);
    if (css) {
      const named = commentAbove(lines, i, from);
      if (named) return `${named}的样式`;
      const head = clip(classWords(cssHead(css[1]).replace(/^[.#]/, "")), 12);
      // 中文尾巴不留空格（「卡片的样式」），英文名后面留一个（「body 的样式」）
      return CHINESE.test(head.slice(-1)) ? `${head}的样式` : `${head} 的样式`;
    }

    // 标签：中文名词 + 所属板块
    const tag = TAG_LINE.exec(line);
    if (tag) {
      // <html> / <meta> 这类只是骨架，说不清在干嘛，继续往上找
      if (STRUCTURAL_TAGS.has(tag[1])) continue;
      const name = ELEMENT_NAMES[tag[1]] ?? tag[1];
      // <style> / <script> 本身就说明了在写什么，不用再套板块
      if (name === "样式" || name === "脚本") return name;
      const block = blockAbove(lines, i, from);
      // div / section 这类只是壳子，板块名（带引号的注释）已经够说明问题了
      if (GENERIC_TAGS.has(tag[1]) && block.startsWith("「")) return block;
      if (block && block !== name) return `${block}里的${name}`;
      return name;
    }
  }
  return "";
}

/**
 * 播放器：把"改文件"这件事按人的速度演出来。
 *
 * 它不产生代码，只负责节奏。三种动作对应真人的三种操作：
 *   create  新建文件，从头打
 *   append  在文件末尾接着写
 *   edit    找到那一段，删掉，把新的打进去（这才是改代码的样子）
 *
 * 演完的缓冲区一定等于最终文件。
 */
export class Player {
  private steps: Step[] = [];
  private cursor = 0;
  private buffers: Record<string, string> = {};
  private pending = "";
  private pendingPath = "";
  private pendingAt = 0;
  /** 最近算出来的"正在写哪一块"，以及上次算它的时间（打字太快，不节流会一直闪） */
  private hint = "";
  private hintAt = 0;
  private carry = 0;
  private last = 0;
  private waitUntil = 0;
  /** 正在演"删除"的那个文件：先停在它上面转一眼，到点再从列表里拿掉 */
  private deleting: string | null = null;
  private deleteAt = 0;
  /** 正在演的动作类型：状态行认它，不认新到的事件（新事件可能还在队列里） */
  private mode: PlayMode = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  paused = false;
  cps = 45;

  /** 相对默认 60 cps 的节奏倍数：滑杆越慢，动作之间停得越久 */
  private get pace() {
    return 60 / Math.max(1, this.cps);
  }

  banner = "准备开始";
  say = "";
  active: string | null = null;
  finished = false;

  onUpdate: (snap: Snapshot) => void = () => {};
  onFinish: () => void = () => {};
  onExhausted: () => void = () => {};

  private waiting = false;
  private running = false;

  push(steps: Step[]) {
    this.steps.push(...steps);
    this.waiting = false;
    if (!this.running) this.start();
  }

  private checkExhausted() {
    if (this.waiting || this.finished) return;
    if (this.cursor >= this.steps.length) {
      this.waiting = true;
      this.onExhausted();
    }
  }

  /** 是否还有东西没演完（循环靠它决定要不要等）。 */
  get busy(): boolean {
    return (
      this.running &&
      !this.finished &&
      (this.pending !== "" || this.deleting !== null || this.cursor < this.steps.length)
    );
  }

  files(): Record<string, string> {
    return { ...this.buffers };
  }

  /** 正在逐字打的那个文件；没在打字就是 null */
  get typingPath(): string | null {
    return this.pendingPath || null;
  }

  /** 手上这段还没打完的字：暂停 / 刷新先存下来，回来才能接着打 */
  typingState(): Typing | null {
    if (!this.pending || !this.pendingPath) return null;
    return {
      path: this.pendingPath,
      shown: this.buffers[this.pendingPath] ?? "",
      rest: this.pending,
      at: this.pendingAt,
      banner: this.banner,
    };
  }

  /**
   * 从「打了一半」的地方接着打。
   *
   * 暂停 / 退出后回到现场时用：屏幕上摆回停下的那半截，剩下的按同一个速度补完，
   * 看起来像接着写，而不是一进来整份文件就已经躺在那。
   */
  resumeTyping(t: Typing) {
    this.steps = [];
    this.cursor = 0;
    this.buffers = { ...this.buffers, [t.path]: t.shown };
    this.active = t.path;
    this.mode = "append";
    if (t.banner) this.banner = t.banner;
    this.pending = t.rest;
    this.pendingPath = t.path;
    // 编辑时剩余的字要插在中间（被替换那段原来的位置），不是接在尾巴上
    this.pendingAt = Math.min(t.at, t.shown.length);
    this.carry = 0;
    this.waitUntil = 0;
    this.deleting = null;
    this.deleteAt = 0;
    this.finished = false;
    this.waiting = false;
    this.running = true;
    this.last = performance.now();
    if (!this.timer) this.timer = setTimeout(this.tick, 16);
    this.emit();
  }

  load(plan: Plan) {
    this.steps = plan.steps;
    this.cursor = 0;
    this.buffers = {};
    for (const path of Object.keys(plan.files)) {
      this.buffers[path] = plan.initial?.[path] ?? "";
    }
    this.pending = "";
    this.pendingPath = "";
    this.pendingAt = 0;
    this.carry = 0;
    this.waitUntil = 0;
    this.deleting = null;
    this.deleteAt = 0;
    this.finished = false;
    this.waiting = false;
    this.banner = "准备开始";
    this.say = "";
    this.active =
      plan.steps.find((st) => st.type === "create")?.path ??
      Object.keys(plan.files)[0] ??
      null;
    this.emit();
    if (this.steps.length) this.start();
  }

  start() {
    if (this.timer) clearTimeout(this.timer);
    this.running = true;
    this.last = performance.now();
    this.timer = setTimeout(this.tick, 16);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 直接设定缓冲区内容（外部校正时用，不播放）。 */
  setBuffers(files: Record<string, string>) {
    this.buffers = { ...files };
    this.pending = "";
    this.pendingPath = "";
    this.mode = null;
    this.emit();
  }

  /**
   * 插话时收手：停下动画，丢掉还没演完的尾巴，但**保留已经打出来的半截**。
   *
   * 千万别顺手把缓冲区对齐成服务端的完整内容：插话的一瞬间整份代码就蹦出来了。
   * 这条被踩过两次，所以那种做法已经从 API 里删掉，只剩「停在半截」这一条路。
   * 也不能只 stop()：pending 还挂着，下一次动作会以为「还在打字」一直排队，
   * 而 tick 已经停了，没人来放行——界面就永远卡在「正在编写」。
   */
  holdTyping() {
    this.stop();
    this.steps = [];
    this.cursor = 0;
    this.pending = "";
    this.pendingPath = "";
    this.pendingAt = 0;
    this.deleting = null;
    this.deleteAt = 0;
    this.mode = null;
    this.emit();
  }

  /** 立刻把剩下的步骤全部应用完（打断时用，保证文件是完整的）。 */
  finishNow() {
    this.stop();
    // 正在逐字打的这一块先补完：只补队列的话，手上这半截会被清掉，
    // 屏幕上就永远停在打了一半（实测 quicksort.py 停在 19/64 行）。
    if (this.pending && this.pendingPath) {
      const body = this.buffers[this.pendingPath] ?? "";
      const at = Math.min(this.pendingAt, body.length);
      this.buffers[this.pendingPath] = body.slice(0, at) + this.pending + body.slice(at);
    }
    while (this.cursor < this.steps.length) {
      const step = this.steps[this.cursor];
      this.cursor += 1;
      switch (step.type) {
        case "create":
          this.buffers[step.path] = step.code;
          this.active = step.path;
          this.banner = step.banner;
          break;
        case "append":
          this.buffers[step.path] = (this.buffers[step.path] ?? "") + step.code;
          this.active = step.path;
          this.banner = step.banner;
          break;
        case "edit": {
          const body = this.buffers[step.path] ?? "";
          const idx = body.indexOf(step.find);
          this.buffers[step.path] =
            idx < 0
              ? body + step.replace
              : body.slice(0, idx) + step.replace + body.slice(idx + step.find.length);
          this.active = step.path;
          this.banner = step.banner;
          break;
        }
        case "delete":
          delete this.buffers[step.path];
          break;
        case "done":
          this.banner = "完成";
          this.say = step.text;
          break;
        default:
          break;
      }
    }
    this.pending = "";
    this.pendingPath = "";
    // 正在演的删除也要落地：否则打断后那个文件永远留在缓冲区里
    // （屏幕上是「文件列表已经没了、代码区还显示它」）
    if (this.deleting) {
      delete this.buffers[this.deleting];
      this.deleting = null;
    }
    this.mode = null;
    this.finished = true;
    this.active = Object.keys(this.buffers)[0] ?? null;
    this.emit();
  }

  reset() {
    this.stop();
    this.cursor = 0;
    this.pending = "";
    this.pendingAt = 0;
    this.carry = 0;
    this.waitUntil = 0;
    this.deleting = null;
    this.deleteAt = 0;
    this.mode = null;
    this.finished = false;
    this.paused = false;
    this.start();
  }

  private tick = () => {
    const now = performance.now();
    const dt = Math.min(now - this.last, 120);
    this.last = now;

    if (this.paused) {
      // 暂停时也别把「还没开演的步骤」直接铺成全量：先把它摆到起点
      // （create 清空、edit 移除原文），字等继续了再打
      if (!this.pending && this.cursor < this.steps.length) this.advance(now);
      this.timer = setTimeout(this.tick, 16);
      return;
    }

    // 删除演到点：这时候才真的从缓冲区里拿掉，列表跟着少一行，选中回到第一个
    if (this.deleting && now >= this.deleteAt) {
      delete this.buffers[this.deleting];
      this.deleting = null;
      this.mode = null;
      this.active = Object.keys(this.buffers)[0] ?? null;
      this.emit();
    }

    if (now < this.waitUntil) {
      this.timer = setTimeout(this.tick, 16);
      return;
    }

    if (this.pending) {
      // 速度只认滑杆：不按文件长度偷偷加速，否则档位就没有任何意义
      const speed = this.cps * (1 + Math.sin(now / 900) * 0.08);
      this.carry += (speed * dt) / 1000;
      const take = Math.floor(this.carry);
      if (take > 0) {
        this.carry -= take;
        const chunk = this.pending.slice(0, take);
        this.pending = this.pending.slice(take);

        const body = this.buffers[this.pendingPath] ?? "";
        const at = Math.min(this.pendingAt, body.length);
        this.buffers[this.pendingPath] = body.slice(0, at) + chunk + body.slice(at);
        this.pendingAt = at + chunk.length;

        // 行尾停顿按当前档位换算，慢档停得久、快档几乎不停
        if (chunk.endsWith("\n")) this.waitUntil = now + 90 * this.pace;
      }
      if (!this.pending) {
        this.pendingPath = "";
        // 这一步打完了：状态行交回给事件流（接下来可能是 think / look）
        this.mode = null;
      }
      this.emit();
    } else {
      this.advance(now);
    }

    this.timer = setTimeout(this.tick, 16);
  };

  private advance(now: number) {
    if (this.cursor >= this.steps.length) {
      this.checkExhausted();
      return;
    }

    const step = this.steps[this.cursor];
    this.cursor += 1;

    switch (step.type) {
      case "banner":
        this.banner = step.text;
        this.mode = null;
        this.waitUntil = now + (step.delay ?? 340) * this.pace;
        break;

      case "create":
        this.buffers[step.path] = "";
        this.active = step.path;
        this.mode = "create";
        this.banner = step.banner;
        this.pending = step.code;
        this.pendingPath = step.path;
        this.pendingAt = 0;
        this.waitUntil = now + (step.delay ?? 160) * this.pace;
        break;

      case "append": {
        this.active = step.path;
        this.mode = "append";
        this.banner = step.banner;
        const body = this.buffers[step.path] ?? "";
        this.pending = step.code;
        this.pendingPath = step.path;
        this.pendingAt = body.length;
        break;
      }

      case "edit": {
        this.active = step.path;
        this.mode = "edit";
        this.banner = step.banner;
        const body = this.buffers[step.path] ?? "";
        const idx = body.indexOf(step.find);
        if (idx < 0) {
          // 找不到就接着末尾写，不吞内容
          this.pending = step.replace;
          this.pendingPath = step.path;
          this.pendingAt = body.length;
        } else {
          this.buffers[step.path] = body.slice(0, idx) + body.slice(idx + step.find.length);
          this.pending = step.replace;
          this.pendingPath = step.path;
          this.pendingAt = idx;
        }
        break;
      }

      case "delete":
        // 先停在要删的那个文件上（左侧高亮、右上角说正在删），过一会儿才真的拿掉，
        // 拿掉的同一刻选中回到第一个文件——别一上来就跳走，看起来像删错了文件
        this.active = step.path;
        this.mode = "delete";
        this.banner = step.banner;
        this.deleting = step.path;
        this.deleteAt = now + Math.max(240, 320 * this.pace);
        this.waitUntil = this.deleteAt;
        break;

      case "done":
        this.banner = "完成";
        this.mode = null;
        this.say = step.text;
        this.finished = true;
        this.waitUntil = now + (step.delay ?? 400) * this.pace;
        this.emit();
        this.onFinish();
        break;
    }

    this.emit();
  }

  private emit() {
    // 提示默认 700ms 最多更新一次：跟着光标逐行变，太勤会闪成一片。
    // 滑杆越慢，字走得越慢，提示也跟着变慢（按 pace 的平方根收，慢档不至于一动不动）
    const now = performance.now();
    const every = Math.max(250, 700 * Math.sqrt(this.pace));
    if (!this.pending) {
      this.hint = "";
    } else if (this.pendingPath && now - this.hintAt > every) {
      this.hintAt = now;
      this.hint = sectionAt(this.buffers[this.pendingPath] ?? "", this.pendingAt);
    }

    this.onUpdate({
      buffers: { ...this.buffers },
      active: this.active,
      mode: this.mode,
      removing: this.deleting,
      banner: this.banner,
      hint: this.hint,
      say: this.say,
      stepIndex: Math.min(this.cursor, this.steps.length),
      total: this.steps.length,
      typing: Boolean(this.pending),
      finished: this.finished,
    });
  }
}