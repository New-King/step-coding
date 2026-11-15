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

export type Snapshot = {
  buffers: Record<string, string>;
  active: string | null;
  /** 正在演删除的文件：还在列表里淡出，过一会儿才真的拿掉 */
  removing: string | null;
  banner: string;
  /** 打字打到的这一小块在干什么（最近的注释 / 函数 / 选择器），没有就是空串 */
  hint: string;
  say: string;
  stepIndex: number;
  total: number;
  typing: boolean;
  finished: boolean;
};

/** 往回最多找这么多行，再往前就不是"这一块"了 */
const HINT_LINES = 60;
/** 提示别太长，右上角浮层就那么宽，再长就截掉 */
const HINT_MAX = 12;

const COMMENT_LINE = /^(?:\/\/|#|--|\/\*|\*|<!--)\s*(.+?)\s*(?:\*\/|-->)?$/;
const FN_LINE = /^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/;
const HANDLE_LINE = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\()/;
const CLASS_LINE = /^(?:export\s+)?(?:class|interface|struct|type)\s+([\w$]+)/;
const CSS_LINE = /^([.#][\w-][^{]*)\{/;
const TAG_LINE = /^<([a-z][\w-]*)([^>]*)>/;

function clip(text: string, max = HINT_MAX) {
  if (text.length <= max) return text;
  // 截断处别留半句标点
  return `${text.slice(0, max).replace(/[，。；、,.;:：\s]+$/, "")}…`;
}

/** `<div class="card">` → `div.card`，`<section id="login">` → `section#login` */
function tagLabel(tag: string, attrs: string) {
  const id = /id="([^"]+)"/.exec(attrs)?.[1]?.trim();
  if (id) return `${tag}#${id}`;
  const cls = /class="([^"]+)"/.exec(attrs)?.[1]?.trim().split(/\s+/)[0];
  if (cls) return `${tag}.${cls}`;
  return `<${tag}>`;
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

/**
 * 正在打字的这一段属于哪一块代码？
 *
 * 从插入点往回找最近的线索：注释行优先（生成出来的代码基本每块都有注释），
 * 其次函数 / 变量 / 类 / CSS 选择器 / HTML 标签。找不到就返回空串，退回整步的标题。
 *
 * 返回的是"这一块叫什么"（`save 的逻辑`、`「登录表单」`），不带"正在写"——
 * 前缀由界面拼，别两边都加，会变成「正在写 正在写 …」。
 */
export function sectionAt(text: string, at: number): string {
  const lines = text.slice(0, at).split("\n");
  const from = Math.max(0, lines.length - HINT_LINES);
  // 从倒数第二行看：最后一行还在敲，读它会出现"登录表"这种半截词
  for (let i = lines.length - 2; i >= from; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;

    // 注释是这一块的名字，用引号括起来，和代码标识区分开
    const comment = COMMENT_LINE.exec(line);
    if (comment?.[1]) {
      const name = commentText(comment[1]);
      if (name) return `「${clip(name, 10)}」`;
    }

    const fn = FN_LINE.exec(line);
    if (fn) return `${clip(fn[1], 12)}() 方法`;

    const handle = HANDLE_LINE.exec(line);
    if (handle) return `${clip(handle[1], 12)} 的逻辑`;

    const cls = CLASS_LINE.exec(line);
    if (cls) return `${clip(cls[1], 12)} 类`;

    const css = CSS_LINE.exec(line);
    if (css) return `${cssHead(css[1])} 的样式`;

    const tag = TAG_LINE.exec(line);
    if (tag) return tagLabel(tag[1], tag[2]);
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
    this.emit();
  }

  /** 立刻把剩下的步骤全部应用完（打断时用，保证文件是完整的）。 */
  finishNow() {
    this.stop();
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
    this.deleting = null;
    this.finished = true;
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
    this.finished = false;
    this.paused = false;
    this.start();
  }

  private tick = () => {
    const now = performance.now();
    const dt = Math.min(now - this.last, 120);
    this.last = now;

    if (this.paused) {
      this.timer = setTimeout(this.tick, 16);
      return;
    }

    // 删除演到点：这时候才真的从缓冲区里拿掉，列表跟着少一行，选中回到第一个
    if (this.deleting && now >= this.deleteAt) {
      delete this.buffers[this.deleting];
      this.deleting = null;
      this.active = Object.keys(this.buffers)[0] ?? null;
      this.emit();
    }

    if (now < this.waitUntil) {
      this.timer = setTimeout(this.tick, 16);
      return;
    }

    if (this.pending) {
      // 速度就是滑杆那个数字，加一点呼吸（±8%）让它不像机器人在跑
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

        if (chunk.endsWith("\n")) this.waitUntil = now + 90 * this.pace;
      }
      if (!this.pending) this.pendingPath = "";
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
        this.waitUntil = now + (step.delay ?? 340) * this.pace;
        break;

      case "create":
        this.buffers[step.path] = "";
        this.active = step.path;
        this.banner = step.banner;
        this.pending = step.code;
        this.pendingPath = step.path;
        this.pendingAt = 0;
        this.waitUntil = now + (step.delay ?? 160) * this.pace;
        break;

      case "append": {
        this.active = step.path;
        this.banner = step.banner;
        const body = this.buffers[step.path] ?? "";
        this.pending = step.code;
        this.pendingPath = step.path;
        this.pendingAt = body.length;
        break;
      }

      case "edit": {
        this.active = step.path;
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
        this.banner = step.banner;
        this.deleting = step.path;
        this.deleteAt = now + Math.max(240, 320 * this.pace);
        this.waitUntil = this.deleteAt;
        break;

      case "done":
        this.banner = "完成";
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