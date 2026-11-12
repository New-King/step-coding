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

export type Snapshot = {
  buffers: Record<string, string>;
  active: string | null;
  banner: string;
  say: string;
  stepIndex: number;
  total: number;
  typing: boolean;
  finished: boolean;
};

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
  private carry = 0;
  private last = 0;
  private waitUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  paused = false;
  cps = 45;

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
    return this.running && !this.finished && (this.pending !== "" || this.cursor < this.steps.length);
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
    this.finished = false;
    this.paused = false;
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

    if (now < this.waitUntil) {
      this.timer = setTimeout(this.tick, 16);
      return;
    }

    if (this.pending) {
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

        if (chunk.endsWith("\n")) this.waitUntil = now + 90;
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
        this.waitUntil = now + (step.delay ?? 340);
        break;

      case "create":
        this.buffers[step.path] = "";
        this.active = step.path;
        this.banner = step.banner;
        this.pending = step.code;
        this.pendingPath = step.path;
        this.pendingAt = 0;
        this.waitUntil = now + (step.delay ?? 160);
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
        delete this.buffers[step.path];
        this.active = Object.keys(this.buffers)[0] ?? null;
        this.banner = step.banner;
        this.waitUntil = now + (step.delay ?? 320);
        break;

      case "done":
        this.banner = "完成";
        this.say = step.text;
        this.finished = true;
        this.waitUntil = now + (step.delay ?? 400);
        this.emit();
        this.onFinish();
        break;
    }

    this.emit();
  }

  private emit() {
    this.onUpdate({
      buffers: { ...this.buffers },
      active: this.active,
      banner: this.banner,
      say: this.say,
      stepIndex: Math.min(this.cursor, this.steps.length),
      total: this.steps.length,
      typing: Boolean(this.pending),
      finished: this.finished,
    });
  }
}