export type Step =
  | { type: "say"; text: string; delay?: number }
  | { type: "create"; path: string; banner: string; delay?: number }
  | { type: "open"; path: string; banner: string; delay?: number }
  | { type: "append"; path: string; text: string; banner: string }
  | { type: "banner"; text: string; delay?: number }
  | { type: "run"; cmd: string; banner: string; delay?: number }
  | { type: "done"; text: string; delay?: number };

export type Plan = {
  task: string;
  steps: Step[];
  files: Record<string, string>;
  stats: { files: number; steps: number; lines: number };
  /** 已有的缓冲区：增量改写时，没动的文件保留原内容 */
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
 * 播放器：把"写文件"这件事按人的速度演出来。
 *
 * 它不产生代码，只负责**节奏**——代码本身来自 steps 里的真实内容，
 * 所以演完的缓冲区一定等于最终文件。
 */
export class Player {
  private steps: Step[] = [];
  private cursor = 0;
  private buffers: Record<string, string> = {};
  private pending = "";
  private pendingPath = "";
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

  /** 边播边追加：真 agent 是一步一步给动作的。 */
  push(steps: Step[]) {
    this.steps.push(...steps);
    this.waiting = false;
    // 有内容才开始跑；空转只会白烧时间
    if (!this.running) this.start();
  }

  /** 队列清空但还没结束 —— 前端据此去问下一步。 */
  private checkExhausted() {
    if (this.waiting || this.finished) return;
    if (this.cursor >= this.steps.length) {
      this.waiting = true;
      this.onExhausted();
    }
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
    this.carry = 0;
    this.waitUntil = 0;
    this.finished = false;
    this.paused = false;
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

  reset() {
    this.stop();
    this.cursor = 0;
    this.pending = "";
    this.carry = 0;
    this.waitUntil = 0;
    this.finished = false;
    this.paused = false;
    for (const path of Object.keys(this.buffers)) this.buffers[path] = "";
    this.banner = "准备开始";
    this.say = "";
    this.emit();
    this.start();
  }

  /** 新任务：清空并重新开始。 */
  resetForTask() {
    this.stop();
    this.steps = [];
    this.cursor = 0;
    this.buffers = {};
    this.pending = "";
    this.pendingPath = "";
    this.carry = 0;
    this.waitUntil = 0;
    this.finished = false;
    this.paused = false;
    this.waiting = false;
    this.banner = "准备开始";
    this.say = "";
    this.active = null;
    this.emit();
  }

  /** 直接跳到第 n 步（用于截图、深链、或"跳过前面"）。 */
  seekTo(target: number) {
    this.stop();
    for (const path of Object.keys(this.buffers)) this.buffers[path] = "";
    this.cursor = 0;
    this.pending = "";
    this.pendingPath = "";
    this.carry = 0;
    this.waitUntil = 0;
    this.finished = false;

    while (this.cursor < Math.min(target, this.steps.length)) {
      const step = this.steps[this.cursor];
      this.cursor += 1;
      switch (step.type) {
        case "say":
          this.say = step.text;
          break;
        case "create":
          this.buffers[step.path] = "";
          this.active = step.path;
          this.banner = step.banner;
          break;
        case "open":
          this.active = step.path;
          this.banner = step.banner;
          break;
        case "append":
          this.active = step.path;
          this.banner = step.banner;
          this.buffers[step.path] = (this.buffers[step.path] ?? "") + step.text;
          break;
        case "banner":
          this.banner = step.text;
          break;
        case "run":
          this.banner = step.banner;
          this.say = `$ ${step.cmd}`;
          break;
        case "done":
          this.banner = "完成";
          this.say = step.text;
          break;
      }
    }

    if (this.cursor >= this.steps.length) {
      this.finished = true;
      this.banner = "完成";
    }
    this.emit();
    this.last = performance.now();
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
      // 变速：长行略快，遇到换行停一下，像人在收行
      const speed = this.cps * (1 + Math.sin(now / 900) * 0.08);
      this.carry += (speed * dt) / 1000;
      const take = Math.floor(this.carry);
      if (take > 0) {
        this.carry -= take;
        const chunk = this.pending.slice(0, take);
        this.pending = this.pending.slice(take);
        this.buffers[this.pendingPath] = (this.buffers[this.pendingPath] ?? "") + chunk;
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
      case "say":
        this.say = step.text;
        this.waitUntil = now + (step.delay ?? 900);
        break;
      case "create":
        this.buffers[step.path] = "";
        this.active = step.path;
        this.banner = step.banner;
        this.waitUntil = now + (step.delay ?? 500);
        break;
      case "open":
        this.active = step.path;
        this.banner = step.banner;
        this.waitUntil = now + (step.delay ?? 400);
        break;
      case "append":
        this.active = step.path;
        this.banner = step.banner;
        this.pending = step.text;
        this.pendingPath = step.path;
        break;
      case "banner":
        this.banner = step.text;
        this.waitUntil = now + (step.delay ?? 340);
        break;
      case "run":
        this.banner = step.banner;
        this.say = `$ ${step.cmd}`;
        this.waitUntil = now + (step.delay ?? 800);
        break;
      case "done":
        this.banner = "完成";
        this.say = step.text;
        this.finished = true;
        this.waitUntil = now + (step.delay ?? 500);
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
