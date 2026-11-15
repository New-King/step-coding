import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import { Player, type Snapshot, type Step } from "./player";
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
  | { action: "finish"; text: string }
  | { action: "say"; text: string }
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

/** 本地留的现场：刷新后能把这一场重新塞回「最近」所需的最小信息 */
type SavedSession = {
  id: string;
  items: Item[];
  files: Record<string, string>;
  round: number;
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
};

const TERMINAL_KINDS = new Set(["say", "finish", "decline"]);

/** 时间线分成两类：对话（用户 / 回话 / 提问 / 拒绝 / 收尾 / 报错）和过程（思考、查看、计划、搜索、写改删） */
const PROCESS_KINDS = new Set(["think", "look", "plan", "search", "write", "edit", "delete"]);

type Row =
  | { kind: "item"; item: Item }
  | { kind: "group"; key: string; items: Item[] };

/** 收尾时「打勾」在浮层上停多久（毫秒）：勾画完再看两秒才收 */
const TOAST_DONE_HOLD = 2000;

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
  removing: null,
  banner: "",
  hint: "",
  say: "",
  stepIndex: 0,
  total: 0,
  typing: false,
  finished: false,
};

const EXAMPLES: { label: string; ask: string }[] = [
  { label: "useEffect 执行时机", ask: "React 的 useEffect 到底什么时候执行" },
  { label: "中间件怎么串起来", ask: "后端的中间件是怎么串起来的" },
  { label: "写一个登录页", ask: "帮我写一个登录页面" },
  { label: "镜像分层怎么回事", ask: "Docker 的镜像分层是怎么回事" },
];

const HISTORY_KEY = "stepcoding.history.v2";
const SESSION_KEY = "stepcoding.session.v1";
const MAX_ROUNDS = 20;

function langOf(name: string) {
  const key = name.toLowerCase();
  if (key.includes("python")) return "python";
  if (key.includes("go")) return "go";
  if (key.includes("css")) return "css";
  if (key.includes("html")) return "xml";
  return "javascript";
}

async function request(url: string, body: unknown, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `请求失败 ${res.status}`);
  }
  return res.json();
}

/** 幂等重试：同一轮重复发不会重复执行，所以可以放心退避重发。 */
async function requestWithRetry(url: string, body: unknown, tries = 3) {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await request(url, body);
    } catch (e) {
      lastError = e;
      const message = String(e);
      if (/请求失败 (4\d\d)/.test(message)) throw e;
      await new Promise((r) => window.setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastError;
}


export default function App() {
  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) playerRef.current = new Player();

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
  const [declined, setDeclined] = useState<Extract<Event, { action: "decline" }> | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  const [copied, setCopied] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);
  const [traceQuery, setTraceQuery] = useState("");
  const [traceOpen, setTraceOpen] = useState(
    () => new URLSearchParams(window.location.search).get("trace") === "1"
  );
  const [logs, setLogs] = useState<{ t: number; tag: string; text: string }[]>([]);

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
  const [ghostLabel, setGhostLabel] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const logStickRef = useRef(true);
  const codeStickRef = useRef(true);

  /** 拍一张当前现场的快照 */
  const snapshot = (): SavedSession => ({
    id: sessionIdRef.current,
    items: itemsRef.current,
    files: filesRef.current,
    round: seqRef.current,
  });

  /** 把现场存下来：刷新后还能在「最近」里找回这一场。 */
  const saveSession = () => {
    if (!sessionIdRef.current) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot()));
    } catch {
      /* 存不下就算 */
    }
  };

  const note = (tag: string, text: string) => {
    const entry = { t: Date.now(), tag, text };
    logsRef.current = [...logsRef.current.slice(-199), entry];
    setLogs(logsRef.current);
    console.info(`[step-coding] ${tag} · ${text}`);
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

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = (s) => {
      setSnap(s);
      // 重播时左栏文件列表没有服务端的 applyChanges 兜底，跟着播放器长出来
      if (replayingRef.current) filesRef.current = { ...s.buffers };
    };
    p.onFinish = () => {};
    p.onExhausted = () => {
      filesRef.current = p.files();

      // 重播演完了：和正常收尾一样，先把浮层切成勾，再收起
      if (replayingRef.current) {
        replayingRef.current = false;
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
        // 没做完的现场也进「最近」：只剩一份列表，不再单独挂一张卡
        if (!projectDone(saved.items)) {
          const firstUser = saved.items.find((i) => i.ev.action === "user");
          upsertHistory({
            id: saved.id,
            title: firstUser?.ev.action === "user" ? titleOf(firstUser.ev.text) : "一个项目",
            items: saved.items,
            files: saved.files ?? {},
            base: {},
            round: saved.round ?? 0,
          });
        }
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

    return () => {
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

  /** 唯一的循环驱动：一次一步，等这一步演完再问下一步。 */
  const pump = async () => {
    // 重播是纯回放：就算有人误触了暂停/继续，也不能去请求下一步
    if (replayingRef.current) return;
    if (pumpingRef.current) {
      note("pump", "已在跑，忽略这次触发");
      return;
    }
    pumpingRef.current = true;
    note("pump", "start");

    try {
      while (statusRef.current === "running") {
        if (seqRef.current >= MAX_ROUNDS) {
          pushStep({ action: "finish", text: "步数到上限，先停在这里" });
          statusRef.current = "done";
          setRunning(false);
          saveSession();
          break;
        }

        const t0 = Date.now();
        const res = await requestWithRetry("/api/step", {
          session_id: sessionIdRef.current,
          seq: seqRef.current,
          message: pendingMessageRef.current,
          pending_search: pendingSearchRef.current || null,
        });

        pendingMessageRef.current = null;
        pendingSearchRef.current = "";
        lastMsRef.current = Date.now() - t0;
        seqRef.current = res.seq;

        if (res.changed) {
          applyChanges(res.changed as Record<string, string | null>);
          serverFilesRef.current = filesRef.current;
        }

        const stop = handleEvent(res.event as Event);
        note("pump", `event=${res.event?.action} stop=${stop}`);
        if (stop) break;
      }
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      note("loop.error", msg);
      setError(msg);
      pushStep({ action: "error", text: msg } as Event);
      statusRef.current = "done";
      setRunning(false);
      saveSession();
    } finally {
      pumpingRef.current = false;
      note("pump", `exit status=${statusRef.current}`);
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
   * 循环和动画是解耦的：模型可能在一个大文件刚开始打字时就返回 finish。
   * 如果立刻切「已完成」，步骤框、文件 loading 都会消失，但代码还在写。
   */
  const afterAnimation = (fn: () => void): true => {
    if (playerRef.current!.busy) afterPlayerRef.current = fn;
    else fn();
    return true;
  };

  /** 处理一个动作。返回 true 表示这一轮到此为止。 */
  const handleEvent = (ev: Event): boolean => {
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
      pushStep(ev);
      if (Object.keys(filesRef.current).length > 0) remember(filesRef.current);
      setPending(ev.questions);
      setAskIndex(0);
      setAskAnswers([]);
      statusRef.current = "waiting";
      setRunning(false);
      saveSession();
      window.setTimeout(() => composerRef.current?.focus(), 60);
      return true;
    }

    if (ev.action === "write" || ev.action === "edit" || ev.action === "delete") {
      pushStep(ev);
      playEvent(ev);
      return false;
    }

    if (ev.action === "error") {
      pushStep(ev);
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

  /** 把一次文件动作演出来，演完继续循环。 */
  const playEvent = (ev: Extract<Event, { action: "write" | "edit" | "delete" }>) => {
    const p = playerRef.current!;

    if (ev.action === "edit") {
      const before = filesRef.current[ev.path] ?? "";
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
        return;
      }
    }
    const files: Record<string, string> = { ...filesRef.current };
    files[ev.path] = files[ev.path] ?? "";

    let step: Step;
    if (ev.action === "write") {
      step = { type: "create", path: ev.path, code: ev.code, banner: ev.label, delay: 160 };
    } else if (ev.action === "edit") {
      step = { type: "edit", path: ev.path, find: ev.find, replace: ev.replace, banner: ev.label };
    } else {
      step = { type: "delete", path: ev.path, banner: ev.label, delay: 320 };
    }

    // 上一段还没演完：直接收尾，保证这一段的起点是对的
    if (p.busy) p.finishNow();

    setPeek(null);
    // 暂停时不要把 paused 重置掉：这一步可以推到时间线，但先不演
    p.load({
      task: ev.label,
      steps: [step],
      files,
      initial: { ...filesRef.current },
      stats: { files: Object.keys(files).length, steps: 1, lines: 0 },
    });

  };

  const finish = (text: string) => {
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
      // 没有新动作就别动它：只是打开看一眼，不该跳到最前面
      if (same >= 0 && prev[same].items.length === entry.items.length) return prev;
      const merged: HistoryItem = {
        ...entry,
        summary: summarize(entry.files),
        title: (same >= 0 ? prev[same].title : "") || entry.title,
        updatedAt: Date.now(),
      };
      const rest = prev.filter((_, i) => i !== same);
      let next = [merged, ...rest].slice(0, 6);

      // 浏览器给每个站点约 5MB，塞不下就把最旧的挤掉再试
      while (next.length > 1) {
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
          break;
        } catch {
          next = next.slice(0, -1);
        }
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

    if (pending) {
      await answerAsk(value);
      return;
    }

    if (!started) {
      await start(value);
      return;
    }

    if (statusRef.current === "running") {
      // 跑的时候不接受新话：先暂停，再说话
      note("send.blocked", "正在跑，忽略这次输入");
      setQuestion(value);
      return;
    }

    playerRef.current!.paused = false;
    setPaused(false);
    clearStage();
    resetRunClock();
    statusRef.current = "running";
    pendingMessageRef.current = value;
    toastReset();
    setRunning(true);
    push({ action: "user", text: value } as Event);
    saveSession();
    await pump();
  };

  const stopRun = () => {
    statusRef.current = "done";
    setRunning(false);
    saveSession();
    note("stop", "本轮结束");
  };

  /** 退出重播：还没演完的步骤一次性落到底，别把半截文件当成现场存下来 */
  const stopReplay = () => {
    if (!replayingRef.current) return;
    replayingRef.current = false;
    const p = playerRef.current!;
    p.finishNow();
    filesRef.current = p.files();
    note("replay", "中途退出，直接落到最终文件");
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

    playerRef.current!.stop();
    playerRef.current!.paused = true;
    setPaused(true);

    // 收尾动作已经在等了：这次其实做完了，finish 里会自己记进「最近」
    const after = afterPlayerRef.current;
    afterPlayerRef.current = null;
    if (after) {
      after();
      setStarted(false);
      return;
    }

    // 中途返回：这一场也记进「最近」，没做完就标未完成，下次点开接着做
    if (itemsRef.current.length > 0) remember(filesRef.current);
    stopRun();
    setStarted(false);
  };

  const togglePause = () => {
    const p = playerRef.current!;
    const next = !p.paused;
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
    filesRef.current = { ...base };
    replayingRef.current = true;
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
    player.stop();
    player.paused = false;
    afterPlayerRef.current = null;
    setPaused(false);
    setStarted(true);
    setError(null);
    setDeclined(null);
    setPending(null);
    setAskIndex(0);
    setAskAnswers([]);
    setAnswer("");
    setRunning(false);
    statusRef.current = "done";
    runStartRef.current = 0;
    setElapsed(0);
    sessionIdRef.current = item.id;
    const items = item.items.map((it) => (it.pending ? { ...it, pending: false } : it));
    itemsRef.current = items;
    setItems(items);
    filesRef.current = item.files;
    startFilesRef.current = item.base ?? {};
    serverFilesRef.current = item.files;
    pendingSearchRef.current = "";
    pendingCardRef.current = null;
    seqRef.current = item.round ?? 0;
    idRef.current = items.reduce((m, i) => Math.max(m, i.id), 0);
    player.setBuffers(item.files);
    setSnap({
      ...EMPTY,
      buffers: item.files,
      active: Object.keys(item.files)[0] ?? null,
      finished: true,
    });

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
    filesRef.current = files;
    serverFilesRef.current = files;
    player.setBuffers(files);
    setSnap((prev) => ({
      ...prev,
      buffers: files,
      active: Object.keys(files)[0] ?? null,
    }));
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

  /* ------------------------------------------------------------ 展示 */

  const firstUserItem = itemsRef.current.find(
    (i) => i.kind === "user" && i.ev.action === "user"
  );
  const projectTitle =
    firstUserItem && firstUserItem.ev.action === "user"
      ? titleOf(firstUserItem.ev.text, 22)
      : "新项目";

  /** 这一场到底做完没有：顶栏和「最近」用的是同一个判断 */
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

  const liveLabel = waitingFirst
    ? WAITING_WORDS[waitWord]
    : typingOut && snap.typing && snap.active
      ? `正在编写 ${snap.active}`
      : liveStatusOf(items, pending, askIndex, running, paused);
  const runTime = runStartRef.current ? elapsedText(elapsed) : "";
  /** 还在跑（或暂停着）：过程块那行说的是「正在做的事」，而不是「过程 · N 步」 */
  const tailLive = running || paused;

  /**
   * 时间线按轮排：用户消息 → 这一轮的过程 → 这一轮的回复。
   *
   * 过程只在本轮内合并成一块（思考和计划排在回复前面，不会掉到最上面去），
   * 换到下一条用户消息才另起一块——多轮对话里每块都贴着自己那条答复。
   */
  const rows = useMemo(() => {
    const out: Row[] = [];
    let bucket: Item[] = [];
    const flush = () => {
      if (!bucket.length) return;
      out.push({ kind: "group", key: `g${bucket[0].id}`, items: bucket });
      bucket = [];
    };
    for (const item of items) {
      if (PROCESS_KINDS.has(item.kind)) {
        bucket.push(item);
        continue;
      }
      // 用户又开口了：上一轮剩下的过程先收口
      flush();
      out.push({ kind: "item", item });
    }
    flush();
    return out;
  }, [items]);

  /** 最后一块过程：还在跑的时候，只有它是 live（换文案、转圈、计时） */
  const lastGroup = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].kind === "group") return i;
    }
    return -1;
  }, [rows]);

  const ideaHandler = (itemId: number) => (text: string) => {
    markUsed(itemId, text);
    void send(text);
  };

  const fileList = Object.keys(filesRef.current).map((path) => ({ path, lang: langOf(path) }));
  const activeFile =
    peek ??
    (snap.active && fileList.some((f) => f.path === snap.active)
      ? snap.active
      : playerRef.current?.active ?? fileList[0]?.path ?? "");

  /** 步骤浮层在转圈：循环在跑，且确实有文件在演 */
  const stepActive = running && snap.total > 0 && !snap.finished;
  // 给收尾回调判断"刚才浮层是不是开着"用；ref 不受闭包那一帧的 state 影响
  useEffect(() => {
    stepActiveRef.current = stepActive;
  }, [stepActive]);

  /** 循环正在跑时的目标文件；用户点别处时它仍然指向这里。 */
  const writingPath = stepActive ? snap.active : null;

  const code = activeFile ? snap.buffers[activeFile] ?? filesRef.current[activeFile] ?? "" : "";
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

  // 过程区：新内容跟着滚，但你滑上去了就不抢
  useEffect(() => {
    const el = logRef.current;
    if (el && logStickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  // 代码区：一边写一边往下跟，同样尊重手动滚动
  useEffect(() => {
    const el = codeRef.current;
    if (el && codeStickRef.current) el.scrollTop = el.scrollHeight;
  }, [code]);

  // 换文件时回到开头看
  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    codeStickRef.current = true;
    el.scrollTop = 0;
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

  const composer = (placeholder: string) => (
    <div className={`composer ${running ? "busy" : ""}`}>
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
        placeholder={running ? "正在跑，先点暂停再说话" : placeholder}
        rows={1}
        disabled={running}
        autoFocus
      />
      <button
        className="composer-send"
        onClick={() => void send(question)}
        disabled={running || !question.trim()}
        title="发送"
      >
        →
      </button>
    </div>
  );

  /* ------------------------------------------------------------ 欢迎页 */

  if (!started) {
    return (
      <div className="ask">
        <div className="ask-hero">
          <div className="ask-inner">
            <div className="ask-mark" />
            <h1>想弄懂什么？</h1>
            <p>说一句。它会先想、再看、再问、再动手——你能看清每一步。</p>
            <div className="ask-examples">
              {EXAMPLES.map((item) => (
                <button key={item.ask} className="ask-chip" onClick={() => void start(item.ask)}>
                  {item.label}
                </button>
              ))}
            </div>
            {composer("说一句…")}

            {declined && (
              <div className="decline-card">
                <div className="decline-text">{declined.text}</div>
                {declined.suggestions.length > 0 && (
                  <div className="decline-ideas">
                    {declined.suggestions.map((idea) => (
                      <button
                        key={idea}
                        className="ask-chip"
                        onClick={() => {
                          setDeclined(null);
                          void start(idea);
                        }}
                      >
                        {idea}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && <div className="ask-error">{error}</div>}

            {history.length > 0 && (
              <section className="ask-history">
                <div className="history-title">
                  <span>最近</span>
                  <button
                    className="history-clear"
                    onClick={() => {
                      localStorage.removeItem(HISTORY_KEY);
                      localStorage.removeItem(SESSION_KEY);
                      setHistory([]);
                    }}
                  >
                    清空
                  </button>
                </div>
                <div className="history-list">
                  {history.map((item) => (
                    <div key={item.id} className="record-card">
                      <button
                        className="record-body record-open"
                        onClick={() => void openHistory(item)}
                      >
                        <span className="record-title">
                          {projectDone(item.items) ? "已完成" : "未完成"}
                        </span>
                        <span className="record-text">{item.title || "最近一次"}</span>
                      </button>
                      <div className="record-actions">
                        <button
                          className="record-icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openHistory(item);
                          }}
                          title="继续修改"
                          aria-label="继续修改"
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="record-icon danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeHistory(item);
                          }}
                          title="删除"
                          aria-label="删除"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  ))}
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
        <div className="brand">
          <span className="logo" />
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
        <label className="speed">
          速度
          <input
            type="range"
            min={20}
            max={160}
            value={cps}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCps(v);
              playerRef.current!.cps = v;
            }}
          />
          <b>{cps}</b>
        </label>
        <button className="ghost" onClick={togglePause}>{paused ? "继续" : "暂停"}</button>
        <button className="ghost" onClick={replay} disabled={running} title="把这一场重新演一遍（不调用模型）">
          重播
        </button>
        <button className="primary" onClick={exportZip}>导出代码</button>
        <button className="ghost" onClick={() => setTraceOpen((v) => !v)}>
          日志{logs.length > 0 ? ` ${logs.length}` : ""}
        </button>
        <button className="ghost" onClick={goHome}>返回</button>
      </header>

      <main className="workspace">
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
                  <span className="file-coding" aria-label="正在写" title="正在写">
                    <GridLoader dot={3} gap={2} />
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="files-none">还没有文件</div>
          )}
          <div className="files-foot">{fileList.length ? `${countLines(filesRef.current)} 行` : "—"}</div>
        </aside>

        <section className="pane">
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
                if (el) codeStickRef.current = nearBottom(el);
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
              <span className="st-tile" aria-hidden>
                {toastDone ? <CheckMark /> : <GridLoader />}
              </span>
              <div className="st-stack">
                {ghostLabel && <span className="st-ghost" key={`g-${ghostLabel}`}>{ghostLabel}</span>}
                <span className="st-text" key={`n-${stepLabel}`}>{stepLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <aside className="chat">
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
                  live={tailLive && i === lastGroup}
                  label={liveLabel}
                  time={runTime}
                  spinning={running && !paused}
                />
              ) : (
                <TimelineItem
                  key={row.item.id}
                  item={row.item}
                  live={row.item.ev.action === "ask" && pending === row.item.ev.questions}
                  onIdea={ideaHandler(row.item.id)}
                />
              )
            )}

            {tailLive && rows[rows.length - 1]?.kind !== "group" && (
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
          <div className="chat-foot">
            {composer(pending ? "回答上面的问题，或直接写…" : "")}
          </div>
        </aside>
      </main>

      {traceOpen && (
        <div className="trace">
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

  return paused ? `已暂停 · ${label}` : label;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
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
  let quiet = 0;

  for (const it of items) {
    const ev = it.ev;
    switch (ev.action) {
      case "look":
        looks.add(ev.path || "根目录");
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

  // 回话和收尾那句都是给用户看的正文，直接铺开，不缩成可点开的摘要
  if (ev.action === "say" || ev.action === "finish") {
    return <div className="tl say">{ev.text || "完成"}</div>;
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

function detailOf(
  ev: Event,
  picked: string | undefined,
  onIdea?: (text: string) => void
): ReactNode | null {
  switch (ev.action) {
    case "think":
    case "error":
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
      if (!ev.results) return null;
      return (
        <div className="tl-search-body">
          {ev.error ? (
            <div className="ws-waiting">搜索失败：{ev.error}</div>
          ) : ev.results.length > 0 ? (
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
          ) : (
            <div className="ws-waiting">没搜到结果</div>
          )}
        </div>
      );

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

