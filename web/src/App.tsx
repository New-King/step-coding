import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import { Player, type Snapshot, type Step, type Typing } from "./player";
import { downloadZip } from "./zip";
import { checkFiles, summarize } from "./check";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);

type Event =
  | { action: "think"; text: string }
  | { action: "look"; path: string }
  | {
      action: "search";
      query: string;
      results?: { title: string; url: string; snippet: string; site?: string }[];
      error?: string;
    }
  | { action: "plan"; steps: string[] }
  | { action: "ask"; questions: { question: string; options: string[] }[] }
  | { action: "write"; path: string; lang: string; label: string; code: string }
  | { action: "edit"; path: string; label: string; find: string; replace: string }
  | { action: "delete"; path: string; label: string }
  | { action: "error"; text: string }
  /** 这一小步被规则拦下（没先 look、文件已存在…）：算过程，模型下一跳会照做 */
  | { action: "blocked"; tool: string; path: string; text: string }
  | { action: "finish"; text: string }
  /** warn：不是故障、但要提一句的提示（如额度用完），按普通回话铺开，只换底色 */
  | { action: "say"; text: string; warn?: boolean }
  | { action: "decline"; text: string; suggestions: string[] }
  | { action: "user"; text: string };

type Item = {
  id: number;
  kind: Event["action"];
  ev: Event;
  picked?: string;
  at?: number;
  ms?: number;
  /** finish 等收尾动作：动画还没演完，先不展示"已完成" */
  pending?: boolean;
};

/**
 * 这一场停在哪种状态：
 * running 正在跑 / waiting 等用户回答 / paused 中途停了还能接着跑 / done 收尾了
 */
type RunStatus = "running" | "waiting" | "paused" | "done";

/** 本地留的现场：刷新后能把这一场重新塞回「最近」所需的最小信息 */
type SavedSession = {
  id: string;
  items: Item[];
  files: Record<string, string>;
  round: number;
  /** 停在哪一步：回来时据此决定是「接着跑」还是「已经结束」 */
  status?: RunStatus;
  /** 停的时候正打到一半的那段字：回来先摆半截，再接着打 */
  typing?: Typing | null;
};

type HistoryItem = {
  id: string;
  title: string;
  summary: string;
  items: Item[];
  base: Record<string, string>;
  files: Record<string, string>;
  round?: number;
  updatedAt?: number;
  /** 老记录没有这一项：按「已完成」处理 */
  status?: RunStatus;
  /** 停的时候正在打的半截：点回来先摆回半截再接着打 */
  typing?: Typing | null;
};

const TERMINAL_KINDS = new Set(["say", "finish", "decline"]);

/** 时间线分成两类：对话（用户 / 回话 / 提问 / 拒绝 / 收尾 / 报错）和过程（思考、查看、计划、搜索、写改删） */
const PROCESS_KINDS = new Set([
  "think",
  "look",
  "plan",
  "search",
  "write",
  "edit",
  "delete",
  "blocked",
]);

/** 真会动文件的三类：重播时按它们把时间线分步放回去 */
const FILE_KINDS = new Set(["write", "edit", "delete"]);

type Row =
  | { kind: "item"; item: Item }
  | { kind: "group"; key: string; items: Item[] }
  /** 搜索结果卡片：算产出，铺在过程块外面，不进折叠里 */
  | { kind: "search"; key: string; item: Item };

/** 收尾时「打勾」在浮层上停多久（毫秒）：勾画完再停一会儿才收，太快看不清 */
const TOAST_DONE_HOLD = 2600;

/** 发出去之后、模型第一个动作回来之前，状态行轮着换的词 */
const WAITING_WORDS = ["思考中", "正在分析", "正在规划", "处理中"];

/** 3×3 方格的顺时针外圈（0 是左上角）；正中间那格不参与转圈 */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];

/** 这条时间线是不是正常收尾了：最后一个收尾动作在最后一句用户消息之后。 */
function projectDone(items: Item[]): boolean {
  let lastTerminal = -1;
  let lastUser = -1;
  items.forEach((item, i) => {
    if (item.kind === "user") lastUser = i;
    if (TERMINAL_KINDS.has(item.kind)) lastTerminal = i;
  });
  return lastTerminal > lastUser;
}

const EMPTY: Snapshot = {
  buffers: {},
  active: null,
  mode: null,
  removing: null,
  banner: "",
  hint: "",
  say: "",
  stepIndex: 0,
  total: 0,
  typing: false,
  finished: false,
};

/**
 * 首页那几个「想弄懂什么」。
 *
 * 口气是「我真有这个问题」，不用命令式，也**别用一个句式套到底**——
 * 八条都写成「我想了解下 X 原理」一眼就是模型生成的。
 * `label` 是按钮上的字，`ask` 是点下去真正发出去的那句。
 */
const EXAMPLES: { label: string; ask: string }[] = [
  {
    label: "登录注册怎么做的",
    ask: "做个最小的登录注册页面：表单校验、登录成功后的状态切换都跑起来，关键步骤写注释",
  },
  {
    label: "function call 怎么落地",
    ask: "写个最小例子演示 function call：模型给的调用是怎么落到真实函数上的，能跑起来",
  },
  {
    label: "LangGraph 节点怎么串",
    ask: "用 TypeScript 写个最小的 LangGraph 例子，两个节点串起来，跑一遍看值怎么流过去",
  },
  {
    label: "什么是快速排序",
    ask: "用 python 写一个快速排序算法",
  },
  {
    label: "爬虫怎么抓页面",
    ask: "写个小爬虫，抓一个页面解析成表格存下来，请求和解析分成两个文件",
  },
  {
    label: "批量改名脚本",
    ask: "写个批量改文件名的脚本：遍历目录、先预览要改成什么、确认后再真正改名",
  },
  {
    label: "单元测试长什么样",
    ask: "写个小函数配上单元测试，正常情况和边界情况都覆盖到，跑一次看结果",
  },
  {
    label: "Dockerfile 写了什么",
    ask: "写个最小 Dockerfile 加启动脚本，每一行都加注释说明它在干什么",
  },
];

const HISTORY_KEY = "stepcoding.history.v2";
const SESSION_KEY = "stepcoding.session.v1";
const CLIENT_KEY = "stepcoding.client.v1";

/** 浏览器身份：只用来按设备算每日 token 额度，清掉缓存就等于换了个新额度 */
function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}
/** 「最近」最多留几条：满了就不让新建，先删一条或清空 */
const MAX_HISTORY = 10;

function langOf(name: string) {
  const key = name.toLowerCase();
  if (key.includes("python")) return "python";
  if (key.includes("go")) return "go";
  if (key.includes("css")) return "css";
  if (key.includes("html")) return "xml";
  return "javascript";
}

/** 带 HTTP 状态码的错误：重试策略要看状态码，不能靠消息文本猜。 */
type HttpError = Error & { status?: number };

async function request(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-client-id": clientId() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err: HttpError = new Error(detail.detail || `请求失败 ${res.status}`);
    // 后端 4xx 一般带 detail（"额度用完了"），消息里没有状态码，必须单独记下来
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 幂等重试：同一轮重复发不会重复执行，所以可以放心退避重发。4xx 不重试。 */
async function requestWithRetry(url: string, body: unknown, tries = 3) {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await request(url, body);
    } catch (e) {
      lastError = e;
      const status = (e as HttpError).status;
      if (status && status < 500) throw e;
      await new Promise((r) => window.setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastError;
}


export default function App() {
  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) playerRef.current = new Player();

  const [theme, toggleTheme] = useTheme();
  const [question, setQuestion] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [started, setStarted] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((x) => Array.isArray(x?.items))
        .map((x, i) => ({ ...x, id: x.id ?? `legacy-${i}` }));
    } catch {
      return [];
    }
  });
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<{ question: string; options: string[] }[] | null>(null);
  const [askIndex, setAskIndex] = useState(0);
  const [askAnswers, setAskAnswers] = useState<string[]>([]);
  // 拒绝的正文和建议直接进时间线（与普通回话同款），这里只留个位置标记
  const [, setDeclined] = useState<Extract<Event, { action: "decline" }> | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  /** 当前落在慢/中/快哪一档（?cps= 传了别的值就归到最近的一档） */
  const speedIndex = SPEEDS.reduce(
    (best, s, i) => (Math.abs(s.cps - cps) < Math.abs(SPEEDS[best].cps - cps) ? i : best),
    0,
  );
  const cycleSpeed = () => {
    const next = SPEEDS[(speedIndex + 1) % SPEEDS.length];
    setCps(next.cps);
    playerRef.current!.cps = next.cps;
  };
  const [copied, setCopied] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  /** 「最近」里正在等二次确认的那条：点垃圾桶先变出对勾 / 叉，别一下就删 */
  /** 「清空」要不要再问一句：单条删除不问，点了就删 */
  const [confirmClear, setConfirmClear] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [traceQuery, setTraceQuery] = useState("");
  const [traceOpen, setTraceOpen] = useState(
    () => new URLSearchParams(window.location.search).get("trace") === "1"
  );
  const [logs, setLogs] = useState<{ t: number; tag: string; text: string }[]>([]);
  /** 手机上输入框默认收起，由右下角的悬浮按钮呼出；桌面上这个状态不起作用 */
  const [composerOpen, setComposerOpen] = useState(false);
  const traceRef = useRef<HTMLDivElement | null>(null);

  /**
   * 手机端上下分屏：中间那条可以拖。
   * `paneH` 为 null 时按 CSS 的 2:1 分；拖过之后是固定像素。
   * 拖动时严格跟手，松手才判断要不要吸附到端点（拖的过程中跳会很生硬）。
   */
  const [paneH, setPaneH] = useState<number | null>(null);
  /** 吸附那一下要一段短过渡；拖动中不能有，否则手感和手指对不上 */
  const [snapping, setSnapping] = useState(false);
  const paneHRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const splitRef = useRef<{ y: number; h: number; max: number } | null>(null);

  /** 离端点这么近就整块让出来 */
  const SNAP = 100;

  const putPaneH = (v: number | null) => {
    paneHRef.current = v;
    setPaneH(v);
  };

  /** 工作区里能分给上下两块的高度：扣掉文件条、这条手柄和上下两道 gap */
  const splitSpace = () => {
    const ws = workspaceRef.current;
    const pane = paneRef.current;
    if (!ws || !pane) return null;
    const filesH = ws.querySelector<HTMLElement>(".files")?.offsetHeight ?? 0;
    const handleH = ws.querySelector<HTMLElement>(".splitter")?.offsetHeight ?? 0;
    return { pane, max: Math.max(0, ws.clientHeight - filesH - handleH - 16) };
  };

  /** 单击恢复初始 2:1：先过渡到对应像素，再交回 CSS 的比例（height 到 auto 没法过渡） */
  const resetSplit = () => {
    const space = splitSpace();
    if (!space) return;
    setSnapping(true);
    putPaneH(Math.round((space.max * 2) / 3));
    window.setTimeout(() => {
      setSnapping(false);
      putPaneH(null);
    }, 200);
  };

  const splitDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const space = splitSpace();
    if (!space) return;
    const handle = e.currentTarget;
    splitRef.current = { y: e.clientY, h: space.pane.offsetHeight, max: space.max };
    setSnapping(false);
    handle.setPointerCapture(e.pointerId);
  };

  const splitMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = splitRef.current;
    if (!d) return;
    const raw = d.h + (e.clientY - d.y);
    putPaneH(Math.min(d.max, Math.max(0, raw)));
  };

  const splitUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = splitRef.current;
    splitRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d) return;

    // 按下几乎没动：当成单击，回到初始比例（已经是初始比例就不用管）
    if (Math.abs(e.clientY - d.y) < 5) {
      if (paneHRef.current !== null) resetSplit();
      return;
    }

    const cur = paneHRef.current;
    if (cur === null) return;
    const target = cur < SNAP ? 0 : cur > d.max - SNAP ? d.max : cur;
    if (target !== cur) {
      setSnapping(true);
      putPaneH(target);
      window.setTimeout(() => setSnapping(false), 220);
    }
  };

  /* 转屏 / 改窗口大小：像素值不再可靠，退回默认比例 */
  useEffect(() => {
    if (paneH === null) return;
    const reset = () => putPaneH(null);
    window.addEventListener("resize", reset);
    window.addEventListener("orientationchange", reset);
    return () => {
      window.removeEventListener("resize", reset);
      window.removeEventListener("orientationchange", reset);
    };
  }, [paneH]);

  /* 点抽屉外面就收起：手机上尤其需要，不然得再点一次日志按钮 */
  useEffect(() => {
    if (!traceOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (traceRef.current?.contains(t)) return;
      // 日志按钮自己会 toggle，别再关一次
      if (t.closest(".trace-toggle")) return;
      setTraceOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [traceOpen]);

  /* 呼出后把光标放进输入框，手机上会连带弹出键盘 */
  useEffect(() => {
    if (!composerOpen) return;
    // preventScroll：不给浏览器机会为了"让输入框可见"去滚一下容器
    const t = setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>(".chat-foot textarea")?.focus({ preventScroll: true });
    }, 40);
    return () => clearTimeout(t);
  }, [composerOpen]);

  const [elapsed, setElapsed] = useState(0);
  /** 步骤浮层收尾：方块停转、画个勾，停 2 秒再收起 */
  const [toastDone, setToastDone] = useState(false);

  const filesRef = useRef<Record<string, string>>({});
  const startFilesRef = useRef<Record<string, string>>({});
  const serverFilesRef = useRef<Record<string, string>>({});
  const itemsRef = useRef<Item[]>([]);
  const idRef = useRef(0);
  const sessionIdRef = useRef("");
  const answeringRef = useRef(false);
  const seqRef = useRef(0);
  const statusRef = useRef<"idle" | "running" | "waiting" | "paused" | "done">("idle");
  const pumpingRef = useRef(false);
  /** 循环正在跑时又来了新指令：等这一轮退出后立刻接着跑，不能把消息吞掉 */
  const pumpQueuedRef = useRef(false);
  /**
   * 插话代数：每插一次话 +1。
   *
   * 请求发出时记下当前代数，回来时代数变了就说明「这是插话前发出的旧请求」——
   * 它带回来的写动作只落数据、不再演，收尾也不作数。
   * 用代数而不是比 seq：插话可能发生在请求发出前后，比 seq 会误判。
   */
  const interruptGenRef = useRef(0);
  const pendingSearchRef = useRef("");
  const pendingMessageRef = useRef<string | null>(null);
  /** 收尾动作（finish / say / decline）等当前文件演完再执行 */
  const afterPlayerRef = useRef<(() => void) | null>(null);
  const lastMsRef = useRef(0);
  const pendingCardRef = useRef<number | null>(null);
  const logsRef = useRef<{ t: number; tag: string; text: string }[]>([]);
  const runStartRef = useRef(0);
  const stepLabelRef = useRef("");
  const bannerRef = useRef("");
  const toastTimerRef = useRef<number | null>(null);
  const stepActiveRef = useRef(false);
  /** 正在重播：只让播放器演，不请求模型、也不走循环 */
  const replayingRef = useRef(false);
  /** 重播要放回去的整条时间线 */
  const replayQueueRef = useRef<Item[]>([]);
  /** 每条要等前面演完几个文件动作才出现，和 queue 一一对应 */
  const replayUnlockRef = useRef<number[]>([]);
  /** 已经放回去几条 */
  const replayShownRef = useRef(0);
  /**
   * 重播开始前那一份完整文件。
   *
   * 取消 / 中途退出不能拿播放器的 buffers 当结果：`finishNow()` 只补还没开演的步骤，
   * 正在一个字一个字打的那个文件，剩下半截会被丢掉。要复位就用这份存下来的原文。
   */
  const replayFilesRef = useRef<Record<string, string>>({});
  /** 只给按钮用（重播中换成「取消」）；判断重播与否一律看 replayingRef */
  const [replaying, setReplaying] = useState(false);
  const [ghostLabel, setGhostLabel] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const logStickRef = useRef(true);
  const codeStickRef = useRef(true);
  /** 上一次由「自动跟随」设上去的 scrollTop：落在这个位置上的 scroll 事件不是用户翻页 */
  const codeAutoTopRef = useRef(-1);

  /** 对外记录用的状态：idle 还没开场，按「已完成」算 */
  const currentStatus = (): RunStatus => (statusRef.current === "idle" ? "done" : statusRef.current);

  /** 拍一张当前现场的快照 */
  const snapshot = (): SavedSession => ({
    id: sessionIdRef.current,
    items: itemsRef.current,
    files: filesRef.current,
    round: seqRef.current,
    status: currentStatus(),
    // 正打到一半也一起存：刷新回来先摆半截，再按原速补完
    typing: playerRef.current?.typingState() ?? null,
  });

  /** 把现场存下来：刷新后还能在「最近」里找回这一场。 */
  const saveSession = () => {
    if (!sessionIdRef.current) return;
    // 重播时时间线是半截的：这时候存下去，刷新后记录就少了半场
    if (replayingRef.current) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot()));
    } catch {
      /* 存不下就算 */
    }
  };

  /** 待上报的前端日志：攒一批再发，别每敲一步就一个请求 */
  const webLogBufRef = useRef<{ t: number; tag: string; text: string }[]>([]);
  const webLogTimerRef = useRef<number | null>(null);

  /**
   * 把前端日志发到后端，落到同一个 `var/traces/<会话>.jsonl`。
   *
   * 只用于排查：报 bug 时不用你说「第几步」，按时间戳和 step 对齐即可。
   * 发失败就当没发生，不能影响主流程。
   */
  const flushWebLog = () => {
    webLogTimerRef.current = null;
    const entries = webLogBufRef.current.splice(0, webLogBufRef.current.length);
    if (!entries.length || !sessionIdRef.current) return;
    void fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionIdRef.current, entries }),
      keepalive: true,
    }).catch(() => {});
  };

  const note = (tag: string, text: string) => {
    const entry = { t: Date.now(), tag, text };
    logsRef.current = [...logsRef.current.slice(-199), entry];
    setLogs(logsRef.current);
    console.info(`[step-coding] ${tag} · ${text}`);
    webLogBufRef.current.push({ t: entry.t, tag, text: String(text).slice(0, 500) });
    if (webLogBufRef.current.length >= 20) flushWebLog();
    else if (!webLogTimerRef.current) {
      webLogTimerRef.current = window.setTimeout(flushWebLog, 1000);
    }
  };

  /** 进出重播都走这里：ref 是判断依据，state 只管按钮长什么样 */
  const markReplaying = (on: boolean) => {
    replayingRef.current = on;
    setReplaying(on);
  };

  /** 新一轮开始时把计时归零；状态行会一直走到这一轮结束。 */
  const resetRunClock = () => {
    runStartRef.current = Date.now();
    setElapsed(0);
  };

  const applyChanges = (changed: Record<string, string | null>) => {
    const next = { ...filesRef.current };
    for (const [path, body] of Object.entries(changed)) {
      if (body === null) delete next[path];
      else next[path] = body;
    }
    filesRef.current = next;
  };

  const markUsed = (id: number, idea: string) => {
    itemsRef.current = itemsRef.current.map((it) =>
      it.id === id ? { ...it, picked: idea } : it
    );
    setItems(itemsRef.current);
  };

  const push = (ev: Event, extra: { ms?: number; pending?: boolean } = {}) => {
    const item: Item = {
      id: (idRef.current += 1),
      kind: ev.action,
      ev,
      at: Date.now(),
      ...extra,
    };
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
    saveSession();
    return item;
  };

  /**
   * 重播时把时间线按进度一条条放回去。
   *
   * `done` 是已经演完的文件动作数：每条动作要等排在它前面的文件演完才露面。
   * 收尾那句和计划排在最后一个文件之后，所以最后一步演完才出来——
   * 否则文件还在打字，回答就已经挂在下面了。
   */
  const replayFeed = (done: number) => {
    const queue = replayQueueRef.current;
    const unlock = replayUnlockRef.current;
    let n = replayShownRef.current;
    while (n < queue.length && unlock[n] <= done) n += 1;
    if (n === replayShownRef.current) return;
    replayShownRef.current = n;
    itemsRef.current = queue.slice(0, n);
    setItems(itemsRef.current);
  };

  /** 重播结束 / 中途退出：整条时间线一次放回去，别留下半截记录 */
  const restoreTimeline = () => {
    const queue = replayQueueRef.current;
    replayQueueRef.current = [];
    replayUnlockRef.current = [];
    replayShownRef.current = 0;
    if (!queue.length) return;
    itemsRef.current = queue;
    setItems(queue);
  };

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = (s) => {
      setSnap(s);
      if (replayingRef.current) {
        // 重播时左栏文件列表没有服务端的 applyChanges 兜底，跟着播放器长出来
        filesRef.current = { ...s.buffers };
        // 这一步已经开演就把排在它前面的话放出来，正在打的这一条等演完
        replayFeed(s.typing ? s.stepIndex - 1 : s.stepIndex);
      }
    };
    p.onFinish = () => {};
    p.onExhausted = () => {
      // 只有重播才拿播放器当数据源（回放没有服务端的 changed 兜底）。
      // 正常跑的时候 filesRef 由 applyChanges 维护，是服务端真值；
      // 用播放器的影子缓冲区覆盖它，edit 下一次就再也对不上原文了。
      if (replayingRef.current) {
        filesRef.current = p.files();
        markReplaying(false);
        // 收尾那句和计划这时才放出来，然后整场记录就齐了
        replayFeed(Number.POSITIVE_INFINITY);
        replayQueueRef.current = [];
        replayUnlockRef.current = [];
        replayShownRef.current = 0;
        replayFilesRef.current = {};
        statusRef.current = "done";
        toastSettle();
        setRunning(false);
        note("replay", "重播结束");
        return;
      }

      const after = afterPlayerRef.current;
      if (after) {
        afterPlayerRef.current = null;
        after();
      }
    };

    let hasSaved = false;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const saved = raw ? (JSON.parse(raw) as SavedSession) : null;
      if (saved && Array.isArray(saved.items) && saved.items.length > 0) {
        hasSaved = true;
        // 现场一律补进「最近」，不按做完没做完分：收尾走 say / 报错 / 步数上限时
        // 没人调 remember()，只补「没做完」的话刷新后这条记录就没了。
        const firstUser = saved.items.find((i) => i.ev.action === "user");
        // 刷新时循环已经断了：正在跑的改记成「暂停」，回来点播放接着跑
        const st: RunStatus = saved.status === "running" ? "paused" : (saved.status ?? "done");
        const entry: HistoryItem = {
          id: saved.id,
          title: firstUser?.ev.action === "user" ? titleOf(firstUser.ev.text) : "一个项目",
          summary: "",
          items: saved.items,
          files: saved.files ?? {},
          base: {},
          round: saved.round ?? 0,
          updatedAt: Date.now(),
          status: st,
          typing: saved.typing ?? null,
        };
        upsertHistory(entry);
        // 不自动跳回现场：刷新停在首页，想继续的人自己去「最近」点。
        // 自动把人拉进一个没写完的对话，等于替他做了「继续」的决定。
      }
    } catch {
      /* 读不出来就算了 */
    }

    // 有现场就别用 ?q= 重开一轮，否则会把现场覆盖掉。
    // 不管用没用，都把 q 从地址栏摘掉，避免下次刷新又自动发一遍。
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      if (!hasSaved) window.setTimeout(() => void start(q), 80);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }

    // 关页 / 切走前再落一次现场：push 存的是「事件刚到手」那一刻，
    // 之后这段字一直在打，不补这一下，回来就只能看到整份文件
    const flush = () => saveSession();
    const onHidden = () => {
      if (document.visibilityState === "hidden") saveSession();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHidden);
      p.stop();
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 运行计时：状态行需要一直走
  useEffect(() => {
    if (!running || !runStartRef.current) return;
    const update = () => setElapsed(Math.floor((Date.now() - runStartRef.current) / 1000));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [running]);


  /* ------------------------------------------------------------ 循环 */

  /**
   * 收尾时把步骤浮层从「转圈」切成「打勾」，勾停下来再收起。
   *
   * 判据用 ref 不用 state：收尾回调是在发起循环那一帧的闭包里跑的，
   * 那里读到的 snap 还是空的，按它判断会永远不亮勾。
   */
  const toastSettle = () => {
    if (!stepActiveRef.current) return;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToastDone(true);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastDone(false);
    }, TOAST_DONE_HOLD);
  };

  const toastReset = () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setToastDone(false);
  };

  const start = async (task: string) => {
    const value = task.trim();
    if (!value) return;

    if (history.length >= MAX_HISTORY) {
      setError(`已经有 ${MAX_HISTORY} 条记录了，删掉一条或清空后再开始`);
      return;
    }

    const player = playerRef.current!;
    player.stop();
    player.paused = false;
    player.setBuffers({});
    afterPlayerRef.current = null;
    setPaused(false);
    setStarted(true);
    setError(null);
    setPending(null);
    toastReset();

    if (new URLSearchParams(window.location.search).has("q")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
    setDeclined(null);
    setItems([]);
    itemsRef.current = [];
    idRef.current = 0;
    filesRef.current = {};
    startFilesRef.current = {};
    serverFilesRef.current = {};
    pendingSearchRef.current = "";
    pendingCardRef.current = null;
    pendingMessageRef.current = value;
    sessionIdRef.current = `s-${Date.now()}`;
    seqRef.current = 0;
    setSnap(EMPTY);
    setAskIndex(0);
    setAskAnswers([]);
    setAnswer("");
    answeringRef.current = false;
    resetRunClock();
    statusRef.current = "running";
    setRunning(true);
    stickLog();
    push({ action: "user", text: value } as Event);
    saveSession();

    try {
      await request("/api/session", {
        id: sessionIdRef.current,
        messages: [],
        files: {},
        seq: 0,
      });
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      note("session.error", msg);
      setError(msg);
      push({ action: "error", text: msg } as Event);
      statusRef.current = "done";
      setRunning(false);
      saveSession();
      return;
    }

    await pump();
  };

  /**
   * 唯一的循环驱动：一次只请求一步。
   *
   * 不等动画演完——新动作到了由 `playEvent` 里的 `finishNow()` 收尾，
   * 只有文字动作（say / decline / finish）一到就把正在演的文件补完，不等动画。
   */
  const pump = async () => {
    // 重播是纯回放：就算有人误触了暂停/继续，也不能去请求下一步
    if (replayingRef.current) return;
    if (pumpingRef.current) {
      // 不能直接丢掉：打断时新消息已经挂上了，丢掉就会永远停在「正在编写」
      pumpQueuedRef.current = true;
      note("pump", "已在跑，排队等它退出");
      return;
    }
    pumpingRef.current = true;
    note("pump", "start");

    try {
      while (statusRef.current === "running") {
        // 步数上限只由后端按「每轮」判，前端不重复判：
        // seqRef 是会话累计步数，拿它比 20 会在聊到第 20 步后把整个会话锁死。
        const t0 = Date.now();
        // 先把这一轮要发的东西取走并清空，再 await。
        // 否则请求返回时会清掉打断期间刚写进来的新消息，界面上就是「说了没反应」。
        const reqSeq = seqRef.current;
        const reqGen = interruptGenRef.current;
        const message = pendingMessageRef.current;
        const pendingSearch = pendingSearchRef.current;
        pendingMessageRef.current = null;
        pendingSearchRef.current = "";
        // 这次请求已经把排队的那句带上了：循环退出时不用再补一轮，
        // 否则同一个问题会被答两遍，还多花一次模型调用
        if (message) pumpQueuedRef.current = false;

        const res = await requestWithRetry("/api/step", {
          session_id: sessionIdRef.current,
          seq: reqSeq,
          message,
          pending_search: pendingSearch || null,
        });

        lastMsRef.current = Date.now() - t0;
        seqRef.current = res.seq;

        // 发出之后被插过话：这是旧请求。动作照样落数据，但不再演，收尾也不作数
        const stale = reqGen !== interruptGenRef.current;

        if (res.changed) {
          applyChanges(res.changed as Record<string, string | null>);
          serverFilesRef.current = filesRef.current;
        }

        const stop = handleEvent(res.event as Event, stale);
        note("pump", `event=${res.event?.action} stop=${stop}`);
        // 每走一步就落一次现场：刷新 / 退出时丢掉的最多只是正在演的这一小段
        saveSession();
        if (stop) break;
      }
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      note("loop.error", msg);
      // 额度用完不是故障：按一句普通回话铺在时间线里，只换底色，不弹错误条
      if (msg.includes("额度")) {
        push({ action: "say", text: msg, warn: true } as Event);
        stopRun();
      } else {
        setError(msg);
        pushStep({ action: "error", text: msg } as Event);
        statusRef.current = "done";
        setRunning(false);
        saveSession();
      }
    } finally {
      pumpingRef.current = false;
      note("pump", `exit status=${statusRef.current}`);
      // 退出时还挂着新指令（打断后又发了一句）就接着跑；
      // 不然新消息只上了屏，永远不会被发出去
      if (pumpQueuedRef.current) {
        pumpQueuedRef.current = false;
        if (statusRef.current === "running") void pump();
      }
    }
  };

  const pushStep = (ev: Event, extra: { pending?: boolean } = {}) => {
    push(ev, { ms: lastMsRef.current, ...extra });
    lastMsRef.current = 0;
  };

  /** 动画演完：把「正在收尾」的占位换回真正的结果。 */
  const settlePending = () => {
    if (!itemsRef.current.some((it) => it.pending)) return;
    itemsRef.current = itemsRef.current.map((it) =>
      it.pending ? { ...it, pending: false } : it
    );
    setItems(itemsRef.current);
  };

  /**
   * 收尾动作要等当前文件演完。
   *
   * 模型可能在一个大文件刚开始打字时就返回 say。立刻把「写好了」铺出来，
   * 屏幕上就是文件还在逐行写、下面已经交差；所以文字排在动画之后。
   */
  const afterAnimation = (fn: () => void): true => {
    if (playerRef.current!.busy) afterPlayerRef.current = fn;
    else fn();
    return true;
  };

  /**
   * 处理一个动作。返回 true 表示这一轮到此为止。
   *
   * `stale` = 这是插话之前发出的那次请求的结果：数据照收，动作不演、收尾不算。
   * 不然会出现「嘴上说停住了，手上还在写 style.css」。
   */
  const handleEvent = (ev: Event, stale = false): boolean => {
    note(ev.action, "text" in ev && ev.text ? ev.text : "path" in ev ? ev.path : "");

    if (ev.action === "search") {
      if (!ev.results) {
        pushStep(ev);
        pendingCardRef.current = itemsRef.current[itemsRef.current.length - 1].id;
        pendingSearchRef.current = ev.query;
        return false;
      }
      const id = pendingCardRef.current;
      pendingCardRef.current = null;
      if (id != null) {
        itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ev } : it));
        setItems(itemsRef.current);
      } else {
        pushStep(ev);
      }
      return false;
    }

    if (ev.action === "think" || ev.action === "look" || ev.action === "plan") {
      pushStep(ev);
      return false;
    }

    if (ev.action === "ask") {
      // 打断后新指令优先：旧轮次的问题不要再弹出来占住输入框
      if (pendingMessageRef.current) return true;
      pushStep(ev);
      if (Object.keys(filesRef.current).length > 0) remember(filesRef.current);
      setPending(ev.questions);
      setAskIndex(0);
      setAskAnswers([]);
      // 新问题进来就是重新开始答：上一轮的锁不能带过来
      answeringRef.current = false;
      statusRef.current = "waiting";
      setRunning(false);
      saveSession();
      window.setTimeout(() => composerRef.current?.focus(), 60);
      return true;
    }

    if (ev.action === "write" || ev.action === "edit" || ev.action === "delete") {
      // 动作一到就进时间线：服务端已经落了盘，过程面板必须记下这一步
      // （尤其是删除——等演到再记，一暂停就永远看不到它）。
      // 状态行另算，它跟播放器（snap.mode / snap.active），不跟这里。
      pushStep(ev);
      if (stale) {
        // 插话前发出的请求：文件确实改了，但用户已经说「等下」，别再演一遍
        note("play.skip", `${ev.path} 是插话前的那一步，不再演`);
        return false;
      }
      // 还在打上一个文件的话，这一段先排着；循环跟着停，演完再接着往下问
      return playEvent(ev);
    }

    if (ev.action === "blocked") {
      // 过程里的一步：原因已经写回历史，模型下一跳会照做，不该弹红条中断
      pushStep(ev);
      return false;
    }

    if (ev.action === "error") {
      pushStep(ev);
      return false;
    }

    if (stale && (ev.action === "say" || ev.action === "decline" || ev.action === "finish")) {
      // 插话前那一轮的收尾：用户已经补了新指令，这句话不算数
      note("play.skip", `旧轮次的 ${ev.action} 丢掉`);
      return false;
    }

    if (ev.action === "say") {
      pushStep(ev);
      return afterAnimation(() => {
        stopRun();
        window.setTimeout(() => composerRef.current?.focus(), 60);
      });
    }

    if (ev.action === "decline") {
      pushStep(ev);
      setPending(null);
      setDeclined(ev);
      return afterAnimation(() => stopRun());
    }

    if (ev.action === "finish") {
      // 先占位成「正在收尾」：正文和自检都等当前文件演完再出现
      pushStep(ev, { pending: true });
      if (Object.keys(filesRef.current).length > 0) remember(filesRef.current);
      return afterAnimation(() => {
        settlePending();
        finish(ev.text);
      });
    }

    note("loop.unknown", JSON.stringify(ev).slice(0, 120));
    push({ action: "error", text: `不认识的动作：${ev.action}` } as Event);
    return false;
  };

  /**
   * 把一次文件动作演出来。
   *
   * 返回 true 表示这一段落到了队列里：上一个文件还没打完，等它打完再演，
   * 否则没打出来的半截会被冲掉，屏幕上一跳就补齐了（暂停回来接着跑时尤其明显）。
   */
  const playEvent = (ev: Extract<Event, { action: "write" | "edit" | "delete" }>): boolean => {
    const p = playerRef.current!;

    // 只有播放器真的在跑（tick 还活着）才值得排队：
    // 停了之后没人会来执行 afterPlayerRef，排着就是永久卡住
    if (p.typingPath && p.busy) {
      note("play.wait", `${p.typingPath} 还在打，先排着`);
      afterPlayerRef.current = () => {
        playEvent(ev);
        void pump();
      };
      return true;
    }

    if (ev.action === "edit") {
      // 必须拿播放器里「改之前」的内容去对原文：
      // filesRef 在 handleEvent 之前就被 applyChanges 换成了改后结果，
      // 用它对 find 永远对不上，edit 会直接跳成最终内容、一个字的动画都没有。
      const before = p.files()[ev.path] ?? "";
      if (!before.includes(ev.find)) {
        // 原文对不上：不要往末尾硬加，直接用服务端算好的内容
        const truth = serverFilesRef.current[ev.path];
        note("edit.mismatch", `${ev.path} 里没找到原文，改用服务端结果`);
        if (typeof truth === "string") {
          const fixed = { ...filesRef.current, [ev.path]: truth };
          filesRef.current = fixed;
          p.setBuffers(fixed);
          setSnap((prev) => ({ ...prev, active: ev.path }));
        }
        return false;
      }
    }
    const files: Record<string, string> = { ...filesRef.current };
    // 删掉的这一步不能再塞回缓冲区：filesRef 里它已经没了，
    // 这里补回来会让「文件列表已空、代码区还在显示刚删掉的文件」。
    if (ev.action !== "delete") files[ev.path] = files[ev.path] ?? "";

    let step: Step;
    if (ev.action === "write") {
      step = { type: "create", path: ev.path, code: ev.code, banner: ev.label, delay: 160 };
    } else if (ev.action === "edit") {
      step = { type: "edit", path: ev.path, find: ev.find, replace: ev.replace, banner: ev.label };
    } else {
      step = { type: "delete", path: ev.path, banner: ev.label, delay: 320 };
    }

    // 剩下的不是打字（比如删除还在演）：直接收尾，保证这一段的起点是对的
    if (p.busy) p.finishNow();

    setPeek(null);
    // 暂停时不要把 paused 重置掉：这一步可以推到时间线，但先不演
    p.load({
      task: ev.label,
      steps: [step],
      files,
      // 起点用播放器当前的进度，不能拿 filesRef：那里已经是写完的完整内容，
      // 新文件会先整份闪一下，再被 create 清空重打
      initial: p.files(),
      stats: { files: Object.keys(files).length, steps: 1, lines: 0 },
    });

    return false;
  };

  const finish = (text: string) => {
    // 打断时已经挂了新指令：这一轮的收尾不能把状态改成「已完成」，
    // 否则循环退出，新消息永远发不出去
    if (pendingMessageRef.current) {
      pumpQueuedRef.current = true;
      return;
    }
    statusRef.current = "done";
    setRunning(false);
    toastSettle();

    const files = filesRef.current;
    if (Object.keys(files).length === 0) {
      saveSession();
      note("finish", "没有产生文件，跳过自检");
      return;
    }
    const issues = checkFiles(files);
    note("finish", `${Object.keys(files).length} 文件 · ${issues.length} 问题`);
    setItems((prev) => prev);

    push({
      action: "plan",
      steps: [summarize(files), ...(issues.length ? issues.map((i) => `${i.file}：${i.text}`) : ["检查通过，没发现问题"])],
    } as Event);

    remember(files);
    void text;
  };

  /** 写进「最近」：一个会话只占一条，改动过的排到最前 */
  const upsertHistory = (entry: Omit<HistoryItem, "summary" | "updatedAt">) => {
    setHistory((prev) => {
      const same = prev.findIndex((x) => x.id === entry.id);
      // 没有新动作就别动它：只是打开看一眼，不该跳到最前面；
      // 但「跑完 / 中途停」这种状态变化要写进去，否则回来还是旧状态
      if (
        same >= 0 &&
        prev[same].items.length === entry.items.length &&
        prev[same].status === entry.status &&
        // 打字打到哪也得算一次变化：返回时没新动作，但半截字往后挪了
        (prev[same].typing?.rest.length ?? 0) === (entry.typing?.rest.length ?? 0)
      ) {
        return prev;
      }
      const merged: HistoryItem = {
        ...entry,
        summary: summarize(entry.files),
        title: (same >= 0 ? prev[same].title : "") || entry.title,
        updatedAt: Date.now(),
      };
      const rest = prev.filter((_, i) => i !== same);
      let next = [merged, ...rest].slice(0, MAX_HISTORY);

      // 浏览器给每个站点约 5MB：塞不下就把最旧的挤掉。留下的这批要同时写进本地，
      // 界面和存储别不一样——否则这里显示着的记录，刷新一下就成了"又没了"。
      let saved = false;
      for (let n = next.length; n >= 1; n -= 1) {
        const list = next.slice(0, n);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
          next = list;
          saved = true;
          break;
        } catch {
          /* 还塞不下就再少留一条 */
        }
      }
      if (!saved) {
        // 连一条都写不进去：界面照常显示，但刷新后会丢，至少日志里留个痕
        console.warn("[step-coding] 「最近」写不进本地存储，这条刷新后会丢");
      }
      return next;
    });
  };

  const remember = (files: Record<string, string>) => {
    const firstUser = itemsRef.current.find(
      (i) => i.kind === "user" && i.ev.action === "user"
    );
    // 一次操作 = 一个项目：按会话 id 认，增删文件都还是同一条
    const sid = sessionIdRef.current || `s-${Date.now()}`;
    sessionIdRef.current = sid;
    upsertHistory({
      id: sid,
      title: firstUser && firstUser.ev.action === "user" ? titleOf(firstUser.ev.text) : "新项目",
      items: itemsRef.current,
      base: startFilesRef.current,
      files,
      round: seqRef.current,
      status: currentStatus(),
      // 「最近」也记半截：从首页点回来才知道该停在哪儿接着打
      typing: playerRef.current?.typingState() ?? null,
    });
  };

  /* ------------------------------------------------------------ 交互 */

  /**
   * 新一轮开口时把代码区那张浮层清干净。
   *
   * 上一轮的 banner / hint 还留在 snap 里，不清的话新一轮头几秒顶着上一轮
   * 最后一句「正在写 xxx」，等第一个文件动作到了才换——看起来像步骤卡住了。
   * buffers 不能动：文件内容要留着，只清显示用的字段。
   */
  const clearStage = () => {
    // 上一轮还在逐字写：这时候清掉，浮层立刻变空，但文件其实还在写——不如让它写完
    if (playerRef.current?.busy) return;
    stepLabelRef.current = "";
    setGhostLabel("");
    setSnap((s) => ({
      ...s,
      banner: "",
      hint: "",
      say: "",
      stepIndex: 0,
      total: 0,
      typing: false,
      finished: false,
    }));
  };

  const answerAsk = async (value: string) => {
    const text = value.trim();
    if (!text || !pending || answeringRef.current) return;
    answeringRef.current = true;

    const next = [...askAnswers, text];
    setAnswer("");

    if (askIndex + 1 < pending.length) {
      setAskAnswers(next);
      setAskIndex(askIndex + 1);
      answeringRef.current = false;
      window.setTimeout(() => composerRef.current?.focus(), 40);
      return;
    }

    // 问题问完了：一题就直接用答案，多题整理成清单再发
    const payload =
      pending.length === 1
        ? text
        : pending.map((q, i) => `${q.question} → ${next[i]}`).join("\n");

    clearStage();
    resetRunClock();
    statusRef.current = "running";
    pendingMessageRef.current = payload;
    setPending(null);
    setAskAnswers([]);
    setAskIndex(0);
    // 这一答已经交出去了，锁必须放开：否则下一次追问的答案会被这层拦下，
    // 输入框清空、卡片不动，看起来就是「说了没反应」
    answeringRef.current = false;
    toastReset();
    setRunning(true);
    push({ action: "user", text: payload } as Event);
    saveSession();
    await pump();
  };

  const send = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    setQuestion("");
    setComposerOpen(false);

    // 底部输入框不是「回答问题」的入口。卡片还开着时从这儿说话 = 这组问题先不答，
    // 直接把卡片撤掉、按新指令走。要逐题回答只能在卡片里点选项或填写：
    // 多题的时候一句话只顶第一题，剩下的还得挨个问，反而不像人话。
    if (pending) {
      setPending(null);
      setAskAnswers([]);
      setAskIndex(0);
      setAnswer("");
      answeringRef.current = false;
    }

    if (!started) {
      await start(value);
      return;
    }

    // 跑着的时候直接说话 = 打断：消息立刻上屏，不再等手上那次请求落地。
    // 以前是 await 它（最长 20 秒）再上屏，看起来就是「说了很久才出来」。
    if (statusRef.current === "running" || pumpingRef.current) {
      note("send.interrupt", "打断正在跑的这一轮");
      // 代数 +1：此刻之前发出的请求回来时算旧动作，只落数据不再演
      interruptGenRef.current += 1;
    }
    // 旧一轮挂着的收尾（say / finish）作废：新指令优先
    afterPlayerRef.current = null;
    // 插话收手：停在演到的地方，不把剩下的字补出来（补了就是「整份代码一下蹦出来」）。
    // 只 stop() 会留下「还在打字」的假象，下一次动作永远排不上（卡在正在编写）
    playerRef.current!.holdTyping();

    playerRef.current!.paused = false;
    setPaused(false);
    clearStage();
    resetRunClock();
    statusRef.current = "running";
    pendingMessageRef.current = value;
    // 循环还在跑就先排队，等它退出时接着把这句话发出去
    pumpQueuedRef.current = true;
    toastReset();
    setRunning(true);
    stickLog();
    push({ action: "user", text: value } as Event);
    saveSession();
    await pump();
  };

  const stopRun = () => {
    // 同上：打断时挂了新指令，旧轮次的话不该结束整轮
    if (pendingMessageRef.current) {
      pumpQueuedRef.current = true;
      return;
    }
    statusRef.current = "done";
    setRunning(false);
    // 回话 / 拒绝收尾也要进「最近」：以前只有 finish 和 返回 才 remember，
    // 聊完直接刷新，这条记录就没进过列表。
    if (itemsRef.current.length > 0) remember(filesRef.current);
    saveSession();
    note("stop", "本轮结束");
  };

  /** 退出重播：还没演完的步骤一次性落到底，别把半截文件当成现场存下来 */
  const stopReplay = () => {
    if (!replayingRef.current) return;
    markReplaying(false);
    const p = playerRef.current!;
    p.finishNow();

    // 别用 p.files()：正在打的那个文件剩半截被 finishNow 丢了，
    // 用重播前存下的完整原文复位，播放器也跟着一起对齐
    const full = replayFilesRef.current;
    replayFilesRef.current = {};
    const files = Object.keys(full).length ? full : p.files();
    filesRef.current = files;
    p.setBuffers(files);

    restoreTimeline();
    note("replay", "中途退出，直接落到最终文件");
  };

  /**
   * 取消重播：直接把画面退回「这一场已经做完」的样子。
   *
   * 剩几步不演了，文件一次落到底，对话整场补回来，状态回到已完成——
   * 和「演完」看起来一样，只是少了最后那几秒。
   */
  const cancelReplay = () => {
    if (!replayingRef.current) return;
    stopReplay();

    const p = playerRef.current!;
    p.stop();
    p.paused = false;
    setPaused(false);
    statusRef.current = "done";
    setRunning(false);
    setSnap((s) => ({ ...s, buffers: filesRef.current, typing: false, finished: true }));
    saveSession();
    note("replay", "取消重播，回到完成后的样子");
  };

  /** 返回首页：停下手上的活，但把现场留着，回来可以继续 */
  const goHome = () => {
    // 重播只是回放，现场早就是完整的：别再存一份「没做完」
    if (replayingRef.current) {
      stopReplay();
      playerRef.current!.stop();
      playerRef.current!.paused = true;
      setPaused(true);
      setStarted(false);
      note("replay", "重播中途返回");
      return;
    }

    // 只暂停，不 stop：stop 会把「还在打字」这件事抹掉（running=false → busy=false），
    // 于是返回途中回来的 finish 一看播放器"不忙"就当场收尾，回来就成了「已完成」。
    // 留着 tick 空转（paused 时它什么都不做），busy 才是真的。
    playerRef.current!.paused = true;
    setPaused(true);

    // 收尾动作（say / finish）还挂在 afterPlayerRef 里也不在这里补：
    // 它等的可能是「文件还没打完」，一补就把这场判成做完了。
    // 留着不动，回来点继续、字打完时它自己会执行——和按暂停一个样。

    // 中途返回：这一场也记进「最近」。跑了一半的记成「暂停」而不是「结束」——
    // 这样再点进来还是停下的样子，点播放能接着跑；等回答的仍记「等回答」。
    if (itemsRef.current.length > 0) {
      if (statusRef.current === "running") statusRef.current = "paused";
      setRunning(false);
      remember(filesRef.current);
      saveSession();
      note("home", `现场留着：${statusRef.current}`);
    }
    setStarted(false);
  };

  const togglePause = () => {
    const p = playerRef.current!;
    const next = !p.paused;

    // 收尾了 / 还没开场：没有「暂停 · 继续」这回事，别按出一个新请求
    if (!replayingRef.current && statusRef.current !== "running" && statusRef.current !== "paused") {
      note("pause", "这一轮已经停下，忽略");
      return;
    }

    p.paused = next;
    setPaused(next);

    // 重播暂停 / 继续：只动播放器，不碰循环状态（循环这边已经结束了）
    if (replayingRef.current) {
      note("pause", next ? "重播暂停" : "重播继续");
      return;
    }

    if (next) {
      statusRef.current = "paused";
      setRunning(false);
      note("pause", "暂停循环与播放");
    } else {
      // 从「最近」点回来接着跑：计时重新起，不然状态行还挂着上一次的秒数
      if (!runStartRef.current) resetRunClock();
      statusRef.current = "running";
      setRunning(true);
      note("resume", "继续");
    }
    saveSession();
    // 收尾动画还在演：只恢复播放，不再请求下一步
    if (!next && !afterPlayerRef.current) void pump();
  };

  /**
   * 重播：把这一场里的文件动作按原来的节奏再演一遍。
   *
   * 全程只用时间线里已有的动作，不请求模型；
   * 但要把现场先退回开场状态（文件清空、浮层亮起），否则看起来和第一次不一样。
   */
  const replay = () => {
    if (statusRef.current === "running" || replayingRef.current) return;

    const after = afterPlayerRef.current;
    afterPlayerRef.current = null;
    after?.();

    const base = startFilesRef.current;
    const steps: Step[] = [];
    for (const item of itemsRef.current) {
      const ev = item.ev;
      if (ev.action === "write") {
        steps.push({ type: "create", path: ev.path, code: ev.code, banner: ev.label, delay: 120 });
      } else if (ev.action === "edit") {
        steps.push({ type: "edit", path: ev.path, find: ev.find, replace: ev.replace, banner: ev.label });
      } else if (ev.action === "delete") {
        steps.push({ type: "delete", path: ev.path, banner: ev.label });
      }
    }
    if (!steps.length) {
      note("replay", "这一场没有文件动作，没什么可重播的");
      return;
    }

    const player = playerRef.current!;
    player.paused = false;
    setPaused(false);
    setPeek(null);
    setSnap(EMPTY);
    // 取消时要用它复位：播放器只会演到一半，演到哪算哪
    replayFilesRef.current = filesRef.current;
    filesRef.current = { ...base };
    markReplaying(true);

    // 对话也退回开场：先把整条时间线记下来，再清空，
    // 只留「还没动文件」那段（用户那句话、思考…），其余跟着播放器一步步放回来
    const queue = itemsRef.current.slice();
    const unlock: number[] = [];
    let done = 0;
    for (const it of queue) {
      unlock.push(done);
      if (FILE_KINDS.has(it.kind)) done += 1;
    }
    replayQueueRef.current = queue;
    replayUnlockRef.current = unlock;
    replayShownRef.current = 0;
    itemsRef.current = [];
    setItems([]);
    replayFeed(0);

    toastReset();
    resetRunClock();
    setRunning(true);
    note("replay", `从开场重演 ${steps.length} 步`);
    player.load({
      task: "重播",
      steps,
      files: base,
      initial: base,
      stats: { files: Object.keys(base).length, steps: steps.length, lines: 0 },
    });
  };

  /** 打开「最近」里的旧项目：先和服务端对齐 seq / messages / files。 */
  const openHistory = async (item: HistoryItem) => {
    const player = playerRef.current!;
    // 拉起来是「接着跑」还是「已经结束」，全看这条记录当时停在哪
    const st: RunStatus = item.status ?? "done";
    const resumable = st === "paused" || st === "running";

    // 返回首页后再点回同一场：tick 还在跑，别 stop——
    // 停了 running=false，busy 就是假的，挂着的收尾会被当场执行
    const sameRun = sessionIdRef.current === item.id;
    if (!sameRun) {
      player.stop();
      // 换了项目才清收尾回调；同一场清了，字打完也没人收尾
      afterPlayerRef.current = null;
    }
    player.paused = resumable;
    setPaused(resumable);
    setStarted(true);
    setError(null);
    setDeclined(null);
    setPending(null);
    setAskIndex(0);
    setAskAnswers([]);
    setAnswer("");
    answeringRef.current = false;
    setRunning(false);
    statusRef.current = resumable ? "paused" : st === "waiting" ? "waiting" : "done";
    runStartRef.current = 0;
    setElapsed(0);
    sessionIdRef.current = item.id;
    const items = item.items.map((it) => (it.pending ? { ...it, pending: false } : it));
    itemsRef.current = items;
    setItems(items);
    // 同一场回来：filesRef 就是最新的（含返回途中刚到的改动），别用记录里的旧值盖回去
    if (!sameRun) {
      filesRef.current = item.files;
      serverFilesRef.current = item.files;
    }
    startFilesRef.current = item.base ?? {};
    pendingSearchRef.current = "";
    pendingCardRef.current = null;
    seqRef.current = item.round ?? 0;
    idRef.current = items.reduce((m, i) => Math.max(m, i.id), 0);

    /**
     * 回来接着打：停的时候手里还剩半截字，就先摆半截，剩下的照原速补完。
     * 直接整份铺出来，看起来像「本来就写完了」，跟离开时对不上。
     */
    const resumeTyping = (all: Record<string, string>) => {
      const t = item.typing;
      if (st !== "paused" || !t?.rest) return;
      const full = t.shown.slice(0, t.at) + t.rest + t.shown.slice(t.at);
      // 服务端内容对不上就不硬接：宁可整份摆出来，也别接出一份错的文件
      if (all[t.path] !== full) return;
      note("history.typing", `${t.path} 还剩 ${t.rest.length} 字`);
      player.resumeTyping(t);
    };

    // 同一场回来：播放器里还留着没打完的半截，别用整份把它冲掉
    const live = sameRun ? player.files() : item.files;
    if (!sameRun) player.setBuffers(item.files);
    setSnap({
      ...EMPTY,
      buffers: live,
      active: Object.keys(live)[0] ?? null,
      // 没跑完的别显示成「已完成」：代码停在离开时那一版
      finished: st === "done",
    });
    if (!sameRun) resumeTyping(item.files);

    // 停在「等回答」上：把那个问题原样摆回来
    if (st === "waiting") {
      const lastAsk = [...items].reverse().find((it) => it.ev.action === "ask");
      if (lastAsk && lastAsk.ev.action === "ask") {
        setPending(lastAsk.ev.questions);
      }
    }

    let sync: { seq?: number; files?: Record<string, string> } | null = null;

    try {
      // 只带 id：会话还在就原样拿回来
      const fresh = await request("/api/session", { id: item.id });
      sync = fresh;
      note("history.sync", `seq=${fresh.seq}`);
    } catch (e) {
      note("history.rebuild", `服务端没有这个会话，按本地文件重建：${String(e)}`);
      try {
        sync = await request("/api/session", {
          id: item.id,
          messages: [],
          files: item.files,
          seq: item.round ?? 0,
        });
      } catch (err) {
        setError(String(err).replace(/^Error:\s*/, ""));
        return;
      }
    }

    if (!sync) return;
    seqRef.current = sync.seq ?? seqRef.current;
    const files = sync.files ?? item.files;
    if (!sameRun) {
      filesRef.current = files;
      serverFilesRef.current = files;
      player.setBuffers(files);
      setSnap((prev) => ({
        ...prev,
        buffers: files,
        active: Object.keys(files)[0] ?? null,
      }));
      resumeTyping(files);
    }

    // 收尾还挂着、播放器又没在演：这场其实已经做完了，回来这一下补上
    if (afterPlayerRef.current && !player.busy) {
      const after = afterPlayerRef.current;
      afterPlayerRef.current = null;
      after();
    }
  };

  /** 从「最近」里删掉一个项目：本地记录 + 服务端会话一起清掉。 */
  const removeHistory = async (item: HistoryItem) => {
    setHistory((prev) => {
      const next = prev.filter((x) => x.id !== item.id);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* 存不下就算了 */
      }
      return next;
    });

    // 删掉的就是当前这一场：本地现场一起清掉，刷新后别再冒出来
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw && (JSON.parse(raw) as SavedSession).id === item.id) {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch {
      /* 忽略 */
    }

    note("history.remove", item.id);
    try {
      await request(`/api/session/${encodeURIComponent(item.id)}`, undefined, "DELETE");
    } catch {
      /* 服务端删不掉不影响本地记录 */
    }
  };

  /** 点删除就删：先让这行淡出收掉高度，再从「最近」里拿掉，免得啪一下没了 */
  const commitDelete = (item: HistoryItem) => {
    setRemovingId(item.id);
    window.setTimeout(() => {
      setRemovingId(null);
      void removeHistory(item);
    }, 260);
  };

  /** 清空「最近」：本地记录和现场快照一起清掉 */
  const clearHistory = () => {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(SESSION_KEY);
    setHistory([]);
    setConfirmClear(false);
    note("history.clear", "清空最近");
  };

  /* ------------------------------------------------------------ 展示 */

  const firstUserItem = itemsRef.current.find(
    (i) => i.kind === "user" && i.ev.action === "user"
  );
  const projectTitle =
    firstUserItem && firstUserItem.ev.action === "user"
      ? titleOf(firstUserItem.ev.text, 22)
      : "新项目";

  /** 顶栏用：收尾动作有没有出现在最后一句之后（「最近」看记录里的 status，不看这个） */
  const projectIsDone = projectDone(items);

  /** 刚发出去、模型还没吐第一个动作：这几个词轮着换，别让界面像卡死 */
  const waitingFirst =
    running && !paused && !pending && items.length > 0 && items[items.length - 1].kind === "user";
  const [waitWord, setWaitWord] = useState(0);
  useEffect(() => {
    if (!waitingFirst) return;
    setWaitWord(0);
    const id = window.setInterval(
      () => setWaitWord((n) => (n + 1) % WAITING_WORDS.length),
      2000
    );
    return () => window.clearInterval(id);
  }, [waitingFirst]);

  /** 模型已经说「收尾」了，但画面还在一个字一个字敲：这时候不是"收尾"，是在写文件 */
  const lastItem = items[items.length - 1];
  const typingOut = lastItem?.ev.action === "finish" && !!lastItem.pending;

  /**
   * 状态行认播放器，不认新到的事件。
   *
   * 事件到手时服务端已经落盘，时间线立刻记一笔（删除必须留痕）；
   * 但画面可能还在打上一个文件，文案要是读事件就会「右边说在写 css、左边还在打 html」。
   * 所以只要播放器手上还有活（snap.mode），就说它正在干的那件事。
   */
  const playerLabel = !snap.mode || !snap.active
    ? ""
    : paused
      ? `已暂停 · 停在 ${snap.active}`
      : snap.mode === "delete"
        ? `正在删除 ${snap.active}`
        : snap.mode === "edit"
          ? `正在修改 ${snap.active}`
          : `正在编写 ${snap.active}`;

  const liveLabel = waitingFirst
    ? WAITING_WORDS[waitWord]
    : playerLabel
      || (typingOut && snap.typing && snap.active
        ? `正在编写 ${snap.active}`
        : liveStatusOf(items, pending, askIndex, running, paused));
  const runTime = runStartRef.current ? elapsedText(elapsed) : "";
  /** 还在跑（或暂停着）：过程块那行说的是「正在做的事」，而不是「过程 · N 步」 */
  const tailLive = running || paused;

  /**
   * 时间线按轮排：用户消息 → 这一轮的过程 → 这一轮的回复。
   *
   * 一轮里的过程只留**一块**，位置固定在回复前面。收尾后补上的自检（plan）
   * 虽然来得比回复晚，也归到这块里——否则回复下面会多挂一条「思考了 1 步」。
   * 换到下一条用户消息才另起一块，多轮对话里每块都贴着自己那条答复。
   */
  const rows = useMemo(() => {
    const rounds: { head: Item | null; body: Item[] }[] = [{ head: null, body: [] }];
    for (const item of items) {
      if (item.ev.action === "user") {
        rounds.push({ head: item, body: [] });
        continue;
      }
      rounds[rounds.length - 1].body.push(item);
    }

    const out: Row[] = [];
    for (const round of rounds) {
      if (round.head) out.push({ kind: "item", item: round.head });
      const process = round.body.filter((it) => PROCESS_KINDS.has(it.kind));
      if (process.length) {
        out.push({ kind: "group", key: `g${process[0].id}`, items: process });
      }
      for (const it of round.body) {
        // 搜到的结果是产出，和回复一样铺在外面；「搜索 xx · n 条」那一行仍留在过程块里
        if (it.kind === "search" && it.ev.action === "search" && it.ev.results?.length) {
          out.push({ kind: "search", key: `s${it.id}`, item: it });
        }
        if (!PROCESS_KINDS.has(it.kind)) out.push({ kind: "item", item: it });
      }
    }
    return out;
  }, [items]);

  /** 最后一块过程：还在跑的时候，只有它是 live（换文案、转圈、计时） */
  const lastGroup = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].kind === "group") return i;
    }
    return -1;
  }, [rows]);

  /**
   * live 的到底是哪一块。
   *
   * 只有「最后一条用户消息之后」的过程块才算本轮——否则第二轮刚开口、还没有任何动作时，
   * 上一轮那块会被当成 live，同时末尾再补一个空的 live 行，屏幕上就出现两条一样的
   * 「正在编写 index.html」。没有本轮过程时返回 -1，由末尾那个空块占位。
   */
  const liveRow = useMemo(() => {
    if (!tailLive || lastGroup < 0) return -1;
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.kind === "item" && row.item.ev.action === "user") {
        lastUser = i;
        break;
      }
    }
    return lastGroup > lastUser ? lastGroup : -1;
  }, [rows, lastGroup, tailLive]);

  const ideaHandler = (itemId: number) => (text: string) => {
    markUsed(itemId, text);
    void send(text);
  };

  const fileList = Object.keys(filesRef.current).map((path) => ({ path, lang: langOf(path) }));
  // 只认文件列表里还在的文件：播放器的 active / 缓冲区可能还停在刚删掉的那个上
  const exists = (path: string | null | undefined): path is string =>
    !!path && fileList.some((f) => f.path === path);
  const activeFile = [peek, snap.active, playerRef.current?.active, fileList[0]?.path].find(exists) ?? "";

  /** 步骤浮层在转圈：循环在跑，且确实有文件在演 */
  const stepActive = running && snap.total > 0 && !snap.finished;
  // 给收尾回调判断"刚才浮层是不是开着"用；ref 不受闭包那一帧的 state 影响
  useEffect(() => {
    stepActiveRef.current = stepActive;
  }, [stepActive]);

  /** 循环正在跑时的目标文件；用户点别处时它仍然指向这里。 */
  const writingPath = stepActive ? snap.active : null;

  /*
   * 只认播放器的缓冲区：服务端的完整内容早就写进 filesRef 了，
   * 这里一旦回退到它，文件刚创建时会先整份闪一下，再被清空重打。
   */
  const code = activeFile ? snap.buffers[activeFile] ?? "" : "";
  const langName = fileList.find((f) => f.path === activeFile)?.lang ?? "javascript";

  const highlighted = useMemo(() => {
    if (!code) return "";
    try {
      return hljs.highlight(code, { language: langName }).value;
    } catch {
      return code;
    }
  }, [code, langName]);

  // 右上角跟着光标走：说到哪一块就写哪一块，没有线索才退回整步的标题
  const stepLabel = snap.hint ? `正在写 ${snap.hint}` : snap.banner || "";
  useEffect(() => {
    if (!snap.total || snap.finished) {
      stepLabelRef.current = "";
      setGhostLabel("");
      return;
    }
    const next = stepLabel;
    if (stepLabelRef.current && stepLabelRef.current !== next) {
      setGhostLabel(stepLabelRef.current);
      stepLabelRef.current = next;
      const timer = window.setTimeout(() => setGhostLabel(""), 420);
      return () => window.clearTimeout(timer);
    }
    stepLabelRef.current = next;
  }, [stepLabel, snap.total, snap.finished]);

  // 卡片弹一下只在「换了一步」时做：细节提示每几秒就变，跟着弹会晃得烦
  const [cardPop, setCardPop] = useState(false);
  useEffect(() => {
    if (!snap.banner) return;
    if (bannerRef.current && bannerRef.current !== snap.banner) {
      setCardPop(true);
      const timer = window.setTimeout(() => setCardPop(false), 520);
      bannerRef.current = snap.banner;
      return () => window.clearTimeout(timer);
    }
    bannerRef.current = snap.banner;
  }, [snap.banner]);

  /** 离底部够近才算"跟着走"，用户往上翻过就停手。 */
  const nearBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < 48;

  /**
   * 自己发消息时强制回到最新一条。
   *
   * 平时不抢滚动条（用户往上翻就是往上翻），但「我刚说的话」必须看得见：
   * 上一条还在下方、自己的问题却没露出来，是最容易让人以为没发出去的。
   */
  const stickLog = () => {
    logStickRef.current = true;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /** 代码区的渐隐按方向给：哪一端还有内容，哪一端才化开 */
  const syncCodeFade = () => {
    const el = codeRef.current;
    if (!el) return;
    el.classList.toggle("can-up", el.scrollTop > 1);
    el.classList.toggle("can-down", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };

  // 过程区：新内容跟着滚，但你滑上去了就不抢
  useEffect(() => {
    const el = logRef.current;
    if (el && logStickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  // 代码区：一边写一边往下跟，同样尊重手动滚动
  useEffect(() => {
    const el = codeRef.current;
    if (!el || !codeStickRef.current) return;
    el.scrollTop = el.scrollHeight;
    codeAutoTopRef.current = el.scrollTop;
    syncCodeFade();
  }, [code]);

  // 换文件时回到开头看
  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    codeStickRef.current = true;
    el.scrollTop = 0;
    codeAutoTopRef.current = 0;
    syncCodeFade();
  }, [activeFile]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 忽略 */
    }
  };

  /** 点步骤框：回到播放器正在写的那个文件。 */
  const followWriting = () => {
    if (snap.active) setPeek(null);
  };

  const exportZip = () => {
    // 重播中途导出的应该是完整结果，不是演到一半的文件
    stopReplay();
    const files = filesRef.current;
    const entries = Object.keys(files)
      .map((path) => ({ path, content: files[path] }))
      .filter((e) => e.content.trim().length > 0);
    if (!entries.length) return;
    downloadZip("step-coding.zip", entries);
  };

  /**
   * 输入框不带任何占位文字：想说什么自己写，别用一句"说一句"教人说话。
   *
   * `prompt` / `send` 只给首页用（终端风的 `›` 和 run）；对话页保持原来的箭头圆钮。
   */
  const composer = (opts: { prompt?: string; send?: string; autoFocus?: boolean } = {}) => (
    <div
      className="composer"
      // 点框里任何地方都落到输入框上，不用非得点中那行字
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) composerRef.current?.focus();
      }}
    >
      {opts.prompt && <span className="composer-prompt">{opts.prompt}</span>}
      <textarea
        ref={composerRef}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send(question);
          }
        }}
        rows={1}
        autoFocus={opts.autoFocus}
      />
      <button
        className={`composer-send ${opts.send ? "text" : ""} ${running ? "interrupt" : ""}`}
        onClick={() => void send(question)}
        disabled={!question.trim()}
        title={running ? "发送并打断当前这一步" : "发送"}
      >
        {opts.send ?? <ArrowUpIcon />}
      </button>
    </div>
  );

  /* ------------------------------------------------------------ 欢迎页 */

  if (!started) {
    return (
      <div className="ask-page">
        <div className="ask-hero">
          <div className="ask-inner">
            <div className="ask-top">
              <span className="left">
                <i className="dot" />
                step-coding · ready
              </span>
              <span className="top-actions">
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                <RepoLink />
              </span>
            </div>

            <h1>
              Take your time
              <span className="caret-block" aria-hidden />
            </h1>
            <p>
              <b>先想 → 再看 → 再问 → 再动手。</b>
              <br />
              代码一行一行写在屏幕上，慢一点也看得清。
            </p>

            {/* 一行走马灯：示例先露出来，输入框跟在下面 */}
            <div className="ask-examples">
              <div className="ask-track">
                {[0, 1].map((copy) => (
                  <div className="ask-set" key={copy} aria-hidden={copy === 1}>
                    {EXAMPLES.map((item) => (
                      <button
                        key={item.ask}
                        className="ask-chip"
                        tabIndex={copy === 1 ? -1 : 0}
                        onClick={() => void start(item.ask)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {composer({ prompt: "›", send: "run", autoFocus: false })}

            {error && <div className="ask-error">{error}</div>}

            {history.length > 0 && (
              <section className="ask-history">
                <div className="history-title">
                  <span>最近 · {history.length}</span>
                  {confirmClear ? (
                    <span className="history-confirm">
                      清空全部？
                      <button
                        className="history-icon danger"
                        onClick={clearHistory}
                        title="确认清空"
                        aria-label="确认清空"
                      >
                        <CheckIcon />
                      </button>
                      <button
                        className="history-icon"
                        onClick={() => setConfirmClear(false)}
                        title="取消"
                        aria-label="取消清空"
                      >
                        <XIcon />
                      </button>
                    </span>
                  ) : (
                    <button className="history-clear" onClick={() => setConfirmClear(true)}>
                      清空
                    </button>
                  )}
                </div>
                <div className="history-list">
                  {history.map((item) => {
                    // 记录里的状态优先：模型可能早就说了收尾，但字还在打，
                    // 这一场其实是停在「暂停」上——按时间线判会误判成打勾
                    const done = item.status ? item.status === "done" : projectDone(item.items);
                    return (
                      <div
                        key={item.id}
                        className={`line ${removingId === item.id ? "removing" : ""}`}
                      >
                        <button className="line-open" onClick={() => void openHistory(item)}>
                          <span className={`ok ${done ? "" : "wait"}`}>
                            {done ? <CheckIcon /> : <PendIcon />}
                          </span>
                          <span className="t">{item.title || "最近一次"}</span>
                          {!done && <span className="meta">未完成</span>}
                        </button>
                        <span className="acts">
                          <button
                            onClick={() => void openHistory(item)}
                            title="继续修改"
                            aria-label="继续修改"
                          >
                            <ArrowIcon />
                          </button>
                          <button
                            className="danger"
                            onClick={() => commitDelete(item)}
                            title="删除"
                            aria-label="删除"
                          >
                            <TrashIcon />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ 工作区 */

  return (
    <div className="app">
      <header className="bar">
        <button className="bar-back" onClick={goHome} title="返回首页" aria-label="返回首页">
          <BackIcon />
        </button>
        <div className="brand">
          <span className="name">{projectTitle}</span>
          <span
            className={`status ${
              running ? "busy" : paused ? "paused" : pending ? "wait" : projectIsDone ? "done" : "wait"
            }`}
          >
            {running
              ? "进行中"
              : paused
                ? "已暂停"
                : pending
                  ? "等你回答"
                  : projectIsDone
                    ? "已完成"
                    : "未完成"}
          </span>
        </div>
        <div className="spacer" />
        <button
          className="tool tip speed-tool"
          data-tip={`速度 · ${SPEEDS[speedIndex].label}`}
          onClick={cycleSpeed}
          aria-label={`演示速度：${SPEEDS[speedIndex].label}，点击切换`}
        >
          <GaugeIcon />
        </button>
        <span className="bar-sep" />
        {replaying ? (
          <button className="tool tip" data-tip="取消重播" onClick={cancelReplay} aria-label="取消重播">
            <XIcon />
          </button>
        ) : (
          <>
            <button
              className="tool tip"
              data-tip={paused ? "继续" : "暂停"}
              onClick={togglePause}
              aria-label={paused ? "继续" : "暂停"}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button
              className="tool tip"
              data-tip="重播"
              onClick={replay}
              disabled={running}
              aria-label="重播"
            >
              <ReplayIcon />
            </button>
          </>
        )}
        <button
          className={`tool tip trace-toggle ${traceOpen ? "on" : ""}`}
          data-tip="日志"
          onClick={() => setTraceOpen((v) => !v)}
          aria-label="日志"
        >
          <LogIcon />
          {logs.length > 0 && <span className="tool-dot" />}
        </button>
        <span className="bar-sep" />
        <button className="primary export" onClick={exportZip} title="导出代码" aria-label="导出代码">
          <DownloadIcon />
          <span className="export-label">导出代码</span>
        </button>
      </header>

      <main className="workspace" ref={workspaceRef}>
        <aside className="files">
          <div className="files-title">
            文件
            <span>{fileList.length}</span>
          </div>
          {fileList.length ? (
            fileList.map((f) => (
              <button
                key={f.path}
                className={`file ${activeFile === f.path ? "on" : ""} ${
                  writingPath === f.path && snap.removing !== f.path ? "coding" : ""
                } ${snap.removing === f.path ? "removing" : ""}`}
                title={f.path}
                onClick={() => setPeek(f.path)}
              >
                <span className="file-name">{f.path}</span>
                {writingPath === f.path && snap.removing !== f.path && (
                  <span className="file-coding" title="正在写" aria-label="正在写">
                    <PencilIcon />
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="files-none">还没有文件</div>
          )}
          <div className="files-foot">{fileList.length ? `${countLines(filesRef.current)} 行` : "—"}</div>
        </aside>

        <section
          className={`pane ${paneH === null ? "" : "manual"} ${snapping ? "snapping" : ""}`}
          ref={paneRef}
          style={paneH === null ? undefined : { height: paneH }}
        >
          <div className="code-card">
            <div className="code-head">
              <span className="code-path">{activeFile || "等待第一步"}</span>
              <span className="code-lines">{code ? code.split("\n").length - 1 : 0} 行</span>
              <button
                className="code-copy"
                onClick={() => void copy()}
                title={copied ? "已复制" : "复制当前文件"}
                aria-label="复制当前文件"
                disabled={!code}
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden>
                    <rect x="8" y="8" width="11" height="11" rx="2" />
                    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                  </svg>
                )}
              </button>
            </div>
            <div
              className="code"
              ref={codeRef}
              onScroll={() => {
                const el = codeRef.current;
                if (!el) return;
                syncCodeFade();
                // 自己刚滚到过的位置：这次事件是跟随造成的，不是用户往上翻
                if (Math.abs(el.scrollTop - codeAutoTopRef.current) < 2) return;
                codeStickRef.current = nearBottom(el);
              }}
            >
              {code ? (
                <>
                  <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
                  {snap.typing && !paused && activeFile === snap.active && (
                    <span className="caret" />
                  )}
                </>
              ) : (
                <div className="code-empty stage-waiting">
                  <span className="stage-dot" />
                  <span>{running ? "它在想接下来做什么…" : "还没有代码"}</span>
                </div>
              )}
            </div>

            <div
              className={`step-toast ${stepActive || toastDone ? "in" : ""} ${
                toastDone ? "done" : ""
              } ${cardPop ? "changing" : ""} ${
                snap.active && activeFile !== snap.active ? "can-follow" : ""
              }`}
              role="button"
              tabIndex={stepActive || toastDone ? 0 : -1}
              title={snap.active ? "回到正在写的文件" : ""}
              onClick={followWriting}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  followWriting();
                }
              }}
            >
              {/* 两个图标都留在同一格：收尾时方块淡出、勾在原位画出来，不是硬切 */}
              <span className={`st-tile ${toastDone ? "done" : ""}`} aria-hidden>
                <GridLoader />
                <CheckMark />
              </span>
              <div className="st-stack">
                {ghostLabel && <span className="st-ghost" key={`g-${ghostLabel}`}>{ghostLabel}</span>}
                <span className="st-text" key={`n-${stepLabel}`}>{stepLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整代码区和对话区的高度，单击恢复默认比例"
          title="单击恢复默认比例"
          onPointerDown={splitDown}
          onPointerMove={splitMove}
          onPointerUp={splitUp}
          onPointerCancel={splitUp}
        />

        <aside className={`chat ${composerOpen ? "composer-open" : ""}`}>
          <div
            className="chat-log"
            ref={logRef}
            onScroll={() => {
              const el = logRef.current;
              if (el) logStickRef.current = nearBottom(el);
            }}
          >
            {rows.map((row, i) =>
              row.kind === "group" ? (
                <ProcessGroup
                  key={row.key}
                  items={row.items}
                  live={i === liveRow}
                  label={liveLabel}
                  time={runTime}
                  spinning={running && !paused}
                />
              ) : row.kind === "search" ? (
                <div key={row.key} className="tl-search-out">
                  {row.item.ev.action === "search" && <SearchCards ev={row.item.ev} />}
                </div>
              ) : (
                <TimelineItem
                  key={row.item.id}
                  item={row.item}
                  live={row.item.ev.action === "ask" && pending === row.item.ev.questions}
                  onIdea={ideaHandler(row.item.id)}
                />
              )
            )}

            {liveRow < 0 && tailLive && (
              <ProcessGroup
                key="live-group"
                items={[]}
                live
                label={liveLabel}
                time={runTime}
                spinning={running && !paused}
              />
            )}

            {pending && (
              <div className="ask-card">
                {pending.length > 1 && (
                  <div className="ask-progress">
                    <span>
                      问题 {askIndex + 1}/{pending.length}
                    </span>
                    <span className="ask-dots">
                      {pending.map((_, i) => (
                        <i
                          key={i}
                          className={i === askIndex ? "on" : i < askIndex ? "done" : ""}
                        />
                      ))}
                    </span>
                  </div>
                )}

                {askAnswers.length > 0 && (
                  <div className="ask-answered">
                    {pending.slice(0, askAnswers.length).map((q, i) => (
                      <div key={i} className="ask-answered-line">
                        <span className="aa-q">{q.question}</span>
                        <span className="aa-a">{askAnswers[i]}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ask-q">{pending[askIndex].question}</div>

                {pending[askIndex].options.length > 0 && (
                  <div className="ask-opts">
                    {pending[askIndex].options.map((opt) => (
                      <button key={opt} className="ask-opt" onClick={() => void answerAsk(opt)}>
                        {opt}
                      </button>
                    ))}
                  </div>
                )}

                <div className="ask-input-row">
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) void answerAsk(answer);
                    }}
                    placeholder="或者自己写…"
                  />
                  <button className="ask-send" onClick={() => void answerAsk(answer)}>
                    →
                  </button>
                </div>
              </div>
            )}

          </div>
          {composerOpen && (
            <button
              className="chat-scrim"
              onClick={() => setComposerOpen(false)}
              aria-label="收起输入框"
              tabIndex={-1}
            />
          )}
          <div className="chat-foot">
            {composer({ autoFocus: true })}
          </div>
          <button className="fab" onClick={() => setComposerOpen(true)} aria-label="开始输入">
            <PencilIcon />
          </button>
        </aside>
      </main>

      {traceOpen && (
        <div className="trace" ref={traceRef}>
          <div className="trace-head">
            <span>轨迹 · {items.length} 步</span>
            <input
              className="trace-search"
              placeholder="搜动作、文件、报错…"
              value={traceQuery}
              onChange={(e) => setTraceQuery(e.target.value)}
            />
            <button className="trace-copy" onClick={() => setTraceOpen(false)}>×</button>
          </div>
          <div className="trace-body">
            {items
              .filter((it) => {
                if (!traceQuery.trim()) return true;
                const hay = JSON.stringify(it.ev) + (it.ms ?? "");
                return hay.toLowerCase().includes(traceQuery.trim().toLowerCase());
              })
              .map((it, i) => {
                const ev = it.ev;
                const time = it.at
                  ? new Date(it.at).toLocaleTimeString("zh-CN", { hour12: false })
                  : "";
                const bad = ev.action === "error" || ev.action === "decline";
                return (
                  <div key={it.id} className={`trace-row ${bad ? "bad" : ""}`}>
                    <span className="tr-index">{i + 1}</span>
                    <span className="tr-time">{time}</span>
                    <span className={`tr-tag ${ev.action}`}>{labelOf(ev.action)}</span>
                    <span className="tr-detail">{describeEvent(ev)}</span>
                    {it.ms ? <span className="tr-ms">{it.ms}ms</span> : null}
                  </div>
                );
              })}

            {logs.filter((l) => !traceQuery.trim() || l.text.includes(traceQuery)).length > 0 && (
              <div className="trace-sub">运行记录</div>
            )}
            {logs
              .filter((l) => !traceQuery.trim() || l.text.includes(traceQuery))
              .slice(-40)
              .map((l, i) => (
                <div key={i} className="trace-row muted">
                  <span className="tr-index">·</span>
                  <span className="tr-time">
                    {new Date(l.t).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span className="tr-tag">{l.tag}</span>
                  <span className="tr-detail">{l.text}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function labelOf(action: string) {
  const map: Record<string, string> = {
    think: "思考",
    look: "查看",
    search: "搜索",
    plan: "计划",
    ask: "提问",
    say: "回话",
    write: "新建",
    edit: "修改",
    delete: "删除",
    finish: "完成",
    decline: "拒绝",
    blocked: "被拦",
    error: "出错",
    user: "你",
  };
  return map[action] ?? action;
}

function describeEvent(ev: Event): string {
  switch (ev.action) {
    case "think":
    case "say":
    case "finish":
    case "decline":
      return ev.text;
    case "look":
      return ev.path || "项目根目录";
    case "search":
      return ev.query;
    case "plan":
      return ev.steps.join(" · ");
    case "ask":
      return ev.questions.map((q) => q.question).join(" / ");
    case "write":
    case "edit":
      return `${ev.path} — ${ev.label}`;
    case "delete":
      return `${ev.path} — ${ev.label}`;
    case "blocked":
      return `${ev.path} — ${ev.text}`;
    case "error":
      return ev.text;
    case "user":
      return ev.text;
    default:
      return "";
  }
}

function elapsedText(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** 收尾的那个勾：描边画出来，浮层和状态行共用 */
function CheckMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="st-check" viewBox="0 0 24 24" style={{ width: size, height: size }} aria-hidden>
      <path d="M5 12.5L10 17.5L19 7" />
    </svg>
  );
}

/**
 * 3×3 小方块 loading：光点沿外圈顺时针绕，拖尾在后面慢慢淡掉。
 * 正中间那格不参与转动，只做很轻的呼吸；尺寸由 dot / gap 决定。
 */
function GridLoader({ dot = 4, gap = 3 }: { dot?: number; gap?: number }) {
  return (
    <span
      className="grid-loader"
      style={{ "--g-dot": `${dot}px`, "--g-gap": `${gap}px` } as CSSProperties}
      aria-hidden
    >
      {Array.from({ length: 9 }, (_, i) => {
        const ring = RING_ORDER.indexOf(i);
        return ring < 0 ? (
          <i key={i} className="core" />
        ) : (
          <i key={i} className="ring" style={{ "--i": ring } as CSSProperties} />
        );
      })}
    </span>
  );
}

/** 过程栏顶部那行：当前这一步在干什么，文字跟着模型返回的动作走。 */
function liveStatusOf(
  items: Item[],
  pending: { question: string }[] | null,
  askIndex: number,
  running: boolean,
  paused: boolean
): string {
  if (pending?.length) {
    return `提问 · ${pending[askIndex]?.question || "等你回答"}`;
  }

  let live: Item | undefined = items[items.length - 1];
  if (!running && live) {
    // 结束后的自检 plan 不是"当前动作"，跳过它找最后一条收尾消息
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].kind === "user") break;
      if (items[i].kind === "plan") continue;
      live = items[i];
      break;
    }
  }

  let label = "准备开始";
  if (live) {
    const ev = live.ev;
    switch (ev.action) {
      case "think":
        label = ev.text;
        break;
      case "look":
        label = `查看 ${ev.path || "项目根目录"}`;
        break;
      case "plan":
        label = `计划 · ${ev.steps.length} 步`;
        break;
      case "search":
        label = ev.results
          ? `搜索「${ev.query}」· ${ev.results.length} 条`
          : `搜索「${ev.query}」`;
        break;
      // 这里只说文件级：具体写到哪一块由代码区右上角那行跟着光标变
      case "write":
        label = `正在编写 ${ev.path}`;
        break;
      case "edit":
        label = `正在修改 ${ev.path}`;
        break;
      case "delete":
        label = `正在删除 ${ev.path}`;
        break;
      case "ask":
        label = `提问 · ${ev.questions[0]?.question ?? ""}`;
        break;
      case "say":
      case "finish":
      case "decline":
        label = live.pending ? "正在收尾…" : ev.text || "完成";
        break;
      case "error":
        label = `出错 · ${ev.text}`;
        break;
      case "user":
        label = `处理「${titleOf(ev.text, 36)}」`;
        break;
    }
  }

  if (!paused) return label;
  // 暂停时别再说「正在编写」：那种半截状态其实是「停在某个文件上」
  if (live && (live.ev.action === "write" || live.ev.action === "edit" || live.ev.action === "delete")) {
    return `已暂停 · 停在 ${live.ev.path}`;
  }
  return `已暂停 · ${label}`;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 演示速度只留三档：拖滑块调一个中间值，没人真的在意 63 和 68 的差别 */
const SPEEDS = [
  { label: "慢", cps: 30 },
  { label: "中", cps: 60 },
  { label: "快", cps: 110 },
];

type Theme = "light" | "dark";

const REPO_URL = "https://github.com/New-King/step-coding";

/** 主题挂在 <html data-theme> 上，首帧由 index.html 的内联脚本先写好 */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("step-theme", theme);
    } catch {
      /* 隐私模式下写不进去，忽略 */
    }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return [theme, toggle] as const;
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === "dark" ? "浅色" : "深色";
  return (
    <button className="icon-btn" onClick={onToggle} title={`切到${next}`} aria-label={`切到${next}`}>
      {/* 明暗各占一半的圆：转过去就是另一面，比画个月亮太阳省事也耐看 */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="contrast"
        style={{ transform: theme === "dark" ? "rotate(180deg)" : "none" }}
      >
        <circle cx="12" cy="12" r="7.5" />
        <path className="solid" d="M12 4.5a7.5 7.5 0 0 1 0 15z" />
      </svg>
    </button>
  );
}

function RepoLink() {
  return (
    <a
      className="icon-btn"
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      title="GitHub 仓库"
      aria-label="GitHub 仓库"
    >
      <GithubIcon />
    </a>
  );
}

function GaugeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 18h14" />
      <path d="M8 18v-5M12 18v-8M16 18v-11" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9.5 6v12M14.5 6v12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 5.8l9.5 6.2L9 18.2z" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M20 12a8 8 0 1 1-2.7-6" />
      <path d="M20 4.5V9h-4.5" />
    </svg>
  );
}

function LogIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  );
}

function PendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 4.5V15M7.5 10.8L12 15.3l4.5-4.5" />
      <path d="M5 18.5h14" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 19V5.5M6.2 11.3L12 5.5l5.8 5.8" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12h13M12.8 6.8L18.5 12l-5.7 5.2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.8 7l.7 11.5a1 1 0 0 0 1 .95h7a1 1 0 0 0 1-.95L17.2 7" />
      <path d="M10.3 11v5M13.7 11v5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="filled">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.93c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.59.23 2.76.12 3.05.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.07.78 2.15v3.19c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12.5L10 17.5L19 7" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function titleOf(text: string, max = 24) {
  const one = (text || "").replace(/\s+/g, " ").trim();
  if (!one) return "新项目";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function countLines(files: Record<string, string>) {
  return Object.values(files).reduce((n, body) => n + body.split("\n").length - 1, 0);
}

/**
 * 过程块收起时的一句话：这一趟读了几个文件、改了几处、搜了几次。
 *
 * 只说做过的事，思考 / 计划不进这句——它们是脑内动作，展开就能看到，
 * 列出来只会把"刚干了什么"淹掉。
 */
function processSummary(items: Item[]) {
  const looks = new Set<string>();
  let searches = 0;
  let writes = 0;
  let edits = 0;
  let deletes = 0;
  let blocked = 0;
  let quiet = 0;

  for (const it of items) {
    const ev = it.ev;
    switch (ev.action) {
      case "look":
        looks.add(ev.path || "根目录");
        break;
      case "blocked":
        blocked += 1;
        break;
      case "search":
        searches += 1;
        break;
      case "write":
        writes += 1;
        break;
      case "edit":
        edits += 1;
        break;
      case "delete":
        deletes += 1;
        break;
      case "think":
      case "plan":
        quiet += 1;
        break;
      default:
        break;
    }
  }

  const parts: string[] = [];
  if (searches) parts.push(`搜索了 ${searches} 次`);
  if (looks.size) parts.push(`读取了 ${looks.size} 个文件`);
  if (writes) parts.push(`新建了 ${writes} 个文件`);
  if (edits) parts.push(`编辑了 ${edits} 处`);
  if (deletes) parts.push(`删除了 ${deletes} 个文件`);
  if (blocked) parts.push(`被拦下 ${blocked} 次`);

  if (parts.length === 0) return quiet ? `思考了 ${quiet} 步，没动文件` : "没有动手";
  return parts.join(" · ");
}

/**
 * 整个过程收成对话顶部的一块：默认收起，点开才看每一步。
 *
 * live 时这一行就是「正在做什么」——loading + 当前动作 + 累计时间，动作一变文字就跟着变；
 * 收起时是一句总结（读了几个文件、改了几处），点开才是每一步。
 * 它属于哪一轮就长在哪一轮前面，不钉在顶部。
 */
function ProcessGroup({
  items,
  live,
  label,
  time,
  spinning,
}: {
  items: Item[];
  live?: boolean;
  label?: string;
  time?: string;
  spinning?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = items.length > 0;
  const summary = useMemo(() => processSummary(items), [items]);

  return (
    <div className={`tl-group ${open ? "open" : ""} ${live ? "live" : ""}`}>
      <button
        className="tl-group-head"
        onClick={() => hasBody && setOpen((v) => !v)}
        aria-expanded={open}
        title={
          hasBody
            ? open
              ? "收起过程"
              : live
                ? "展开过程"
                : `${summary} · 点开看每一步`
            : undefined
        }
      >
        {live && (
          <span className="run-tile" aria-hidden>
            {spinning ? <GridLoader dot={3} gap={2} /> : <span className="run-idle-dot" />}
          </span>
        )}
        <span className={`tl-group-title ${live ? "live" : "summary"}`}>
          {live ? label || "处理中" : summary}
        </span>
        {live && time && <span className="tl-group-time">{time}</span>}
        {hasBody && <span className="tl-group-chevron" aria-hidden />}
      </button>
      {open && hasBody && (
        <div className="tl-group-body">
          {items.map((it) => (
            <TimelineItem key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineItem({
  item,
  live,
  onIdea,
}: {
  item: Item;
  live?: boolean;
  onIdea?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = item.picked;
  const ev = item.ev;

  if (ev.action === "user") {
    return (
      <div className="tl user">
        <span>{ev.text}</span>
      </div>
    );
  }

  // finish 还挂着"正在收尾"时，过程块那行已经在说，别在列表里再重复一条
  if (ev.action === "finish" && item.pending) return null;

  // 回话、收尾、拒绝都是给用户看的正文，一律铺开，不缩成可点开的摘要；
  // 拒绝额外挂几个能直接点的替代做法
  if (ev.action === "say" || ev.action === "finish" || ev.action === "decline") {
    const warn = ev.action === "say" && ev.warn === true;
    return (
      <div className={warn ? "tl say warn" : `tl ${ev.action}`}>
        {ev.text || (ev.action === "decline" ? "" : "完成")}
        {ev.action === "decline" && ev.suggestions.length > 0 && (
          <div className="decline-ideas">
            {ev.suggestions.map((idea) => (
              <button
                key={idea}
                className="decline-idea"
                onClick={() => onIdea?.(idea)}
                title="点一下就按这个开工"
              >
                {idea}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 正在等用户回答时，问题由下面的 ask-card 展示，时间线里先不重复
  if (ev.action === "ask" && live) return null;

  const kind = kindOf(ev.action);
  const summary = summaryOf(ev);
  const detail = detailOf(ev, picked, onIdea);
  const expandable = detail !== null;

  return (
    <div className={`tl ${ev.action} collapsible ${open ? "open" : ""}`}>
      <button
        className={`tl-row ${expandable ? "" : "static"}`}
        onClick={() => {
          if (expandable) setOpen((v) => !v);
        }}
        aria-expanded={expandable ? open : undefined}
        tabIndex={expandable ? 0 : -1}
      >
        {kind && <span className="tl-kind">{kind}</span>}
        <span className="tl-summary">{summary}</span>
        {expandable && <span className={`tl-chevron ${open ? "open" : ""}`} aria-hidden />}
      </button>
      {expandable && open && <div className="tl-detail">{detail}</div>}
    </div>
  );
}

function kindOf(action: Event["action"]): string {
  const map: Record<string, string> = {
    think: "思考",
    look: "查看",
    search: "搜索",
    plan: "计划",
    ask: "提问",
    write: "",
    edit: "",
    delete: "",
    decline: "拒绝",
    error: "出错",
    user: "你",
  };
  return map[action] ?? "";
}

function summaryOf(ev: Event): ReactNode {
  switch (ev.action) {
    case "think":
      return <span className="tl-summary-text">{ev.text || "…"}</span>;
    case "look":
      return <span className="tl-summary-text">{ev.path || "项目根目录"}</span>;
    case "search":
      return (
        <>
          {!ev.results && <span className="ws-ring" />}
          <span className="tl-summary-text">
            {ev.query}
            {ev.results ? ` · ${ev.results.length} 条` : ""}
          </span>
        </>
      );
    case "plan":
      return <span className="tl-summary-text">{ev.steps.length} 步</span>;
    case "ask":
      return <span className="tl-summary-text">{ev.questions[0]?.question || "提问"}</span>;
    case "write":
    case "edit":
    case "delete":
      return (
        <>
          <span
            className={`op-tag ${ev.action === "write" ? "new" : ev.action === "edit" ? "edit" : "del"}`}
          >
            {ev.action === "write" ? "新建" : ev.action === "edit" ? "修改" : "删除"}
          </span>
          <span className="op-path">{ev.path}</span>
          <span className="op-label">{ev.label}</span>
        </>
      );
    case "blocked": {
      const label =
        ev.tool === "write" ? "新建" : ev.tool === "edit" ? "修改" : ev.tool === "delete" ? "删除" : ev.tool;
      return (
        <>
          <span className="op-tag del">被拦</span>
          <span className="op-path">{ev.path || label}</span>
          <span className="op-label">{ev.text.split("\n")[0]}</span>
        </>
      );
    }
    case "decline":
      return <span className="tl-summary-text">{ev.text}</span>;
    case "error":
      return <span className="tl-summary-text">{ev.text}</span>;
    case "user":
      return <span className="tl-summary-text">{ev.text}</span>;
    default:
      return null;
  }
}

/** 搜到的网页卡片：算产出，铺在过程块外面，最多 4 张 */
function SearchCards({ ev }: { ev: Extract<Event, { action: "search" }> }) {
  if (!ev.results || ev.results.length === 0) return null;
  return (
    <div className="ws-grid">
      {ev.results.slice(0, 4).map((r, i) => (
        <a
          key={i}
          className="ws-card"
          style={{ animationDelay: `${i * 45}ms` }}
          href={r.url}
          target="_blank"
          rel="noreferrer"
        >
          <span className="ws-fav">{(r.site || hostOf(r.url))[0] ?? "·"}</span>
          <span className="ws-title">{r.title || r.url}</span>
          <span className="ws-host">{hostOf(r.url)}</span>
        </a>
      ))}
    </div>
  );
}

function detailOf(
  ev: Event,
  picked: string | undefined,
  onIdea?: (text: string) => void
): ReactNode | null {
  switch (ev.action) {
    case "think":
    case "error":
    case "blocked":
      return ev.text ? <div className="tl-text">{ev.text}</div> : null;

    case "plan":
      return (
        <div className="tl-plan-body">
          {ev.steps.map((s, i) => (
            <div key={i} className="plan-step">
              <span className="plan-i">{i + 1}</span>
              {s}
            </div>
          ))}
        </div>
      );

    case "search":
      // 结果卡片是产出，铺在过程块外面（SearchCards）；这里只留失败原因
      return ev.error ? <div className="ws-waiting">搜索失败：{ev.error}</div> : null;

    case "ask":
      return (
        <div className="ask-done">
          {ev.questions.map((q, i) => (
            <div key={i} className="ask-done-q">
              {q.question}
              {q.options.length > 0 && (
                <div className="ask-done-opts">{q.options.join(" · ")}</div>
              )}
            </div>
          ))}
        </div>
      );

    // 写文件 / 改文件不铺代码：正文区就在旁边，时间线再抄一遍只会越点越深。
    // 展开只看思路——思考全文、计划步骤、搜索结果。
    case "write":
    case "edit":
    case "delete":
    case "look":
      return null;

    case "decline":
      return (
        <>
          <div className="tl-text">{ev.text}</div>
          {ev.suggestions.length > 0 && (
            <div className="decline-ideas">
              {picked
                ? ev.suggestions.map((idea) => (
                    <span
                      key={idea}
                      className={`decline-idea-static ${idea === picked ? "chosen" : ""}`}
                    >
                      {idea}
                    </span>
                  ))
                : ev.suggestions.map((idea) => (
                    <button
                      key={idea}
                      className="decline-idea"
                      onClick={() => onIdea?.(idea)}
                      title="点一下就按这个开工"
                    >
                      {idea}
                    </button>
                  ))}
            </div>
          )}
        </>
      );

    case "user":
      return null;
    default:
      return null;
  }
}

