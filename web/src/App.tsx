import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/** 服务端的 messages 里有 tool_calls 等嵌套结构，前端只负责原样存回。 */
type ChatMessage = { role: string; content?: string; tool_calls?: unknown[] };

type SavedSession = {
  id: string;
  items: Item[];
  files: Record<string, string>;
  messages: ChatMessage[];
  round: number;
  pending: { question: string; options: string[] }[] | null;
  askIndex: number;
  askAnswers: string[];
  status: "running" | "paused" | "waiting" | "done";
  started: boolean;
  savedAt: number;
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

/**
 * 这次现场是不是正常收尾了。
 *
 * 只看 status 不够：旧版本在 say / decline / 无文件的 finish 之后没有落盘状态，
 * 会留下 "running"。所以再看时间线里最后一次收尾动作是否在最后一句用户消息之后。
 */
function endedNormally(saved: SavedSession): boolean {
  if (saved.status === "done") return true;
  if (saved.pending?.length) return false;

  let lastTerminal = -1;
  let lastUser = -1;
  saved.items.forEach((item, i) => {
    if (item.kind === "user") lastUser = i;
    if (TERMINAL_KINDS.has(item.kind)) lastTerminal = i;
  });
  return lastTerminal > lastUser;
}

const EMPTY: Snapshot = {
  buffers: {},
  active: null,
  banner: "",
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
  const [resumable, setResumable] = useState<SavedSession | null>(null);
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
  const [processOpen, setProcessOpen] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const messagesRef = useRef<ChatMessage[]>([]);
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
    messages: messagesRef.current,
    round: seqRef.current,
    pending,
    askIndex,
    askAnswers,
    status: statusRef.current === "idle" ? "done" : statusRef.current,
    started,
    savedAt: Date.now(),
  });

  /** 把现场存下来：刷新/返回后能接着干。 */
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
    p.onUpdate = (s) => setSnap(s);
    p.onFinish = () => {};
    p.onExhausted = () => {
      filesRef.current = p.files();
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
        // 正常收尾的现场不弹「上次没做完」，也不该点一下就自动再发一轮
        if (!endedNormally(saved)) setResumable(saved);
        hasSaved = true;
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

    return () => p.stop();
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

  // 有提问或报错时必须展开，不然用户看不到问题
  useEffect(() => {
    if (pending || error) setProcessOpen(true);
  }, [pending, error]);

  /* ------------------------------------------------------------ 循环 */

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
    messagesRef.current = [];
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

  const remember = (files: Record<string, string>) => {
    const firstUser = itemsRef.current.find(
      (i) => i.kind === "user" && i.ev.action === "user"
    );
    const title =
      firstUser && firstUser.ev.action === "user" ? titleOf(firstUser.ev.text) : "新项目";
    const item: HistoryItem = {
      id: "",
      title,
      summary: summarize(files),
      items: itemsRef.current,
      base: startFilesRef.current,
      files,
      round: seqRef.current,
    };
    // 一次操作 = 一个项目：按会话 id 认，增删文件都还是同一条
    const sid = sessionIdRef.current || `s-${Date.now()}`;
    sessionIdRef.current = sid;

    setHistory((prev) => {
      const same = prev.findIndex((x) => x.id === sid);
      const merged =
        same >= 0
          ? { ...item, id: sid, title: prev[same].title || item.title, updatedAt: Date.now() }
          : { ...item, id: sid, updatedAt: Date.now() };
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

  /* ------------------------------------------------------------ 交互 */

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

    resetRunClock();
    statusRef.current = "running";
    pendingMessageRef.current = payload;
    setPending(null);
    setAskAnswers([]);
    setAskIndex(0);
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
    resetRunClock();
    statusRef.current = "running";
    pendingMessageRef.current = value;
    setRunning(true);
    push({ action: "user", text: value } as Event);
    saveSession();
    await pump();
  };

  /** 从上次的现场接着干 */
  const resume = async () => {
    const saved = resumable;
    if (!saved) return;

    setStarted(true);
    setResumable(null);
    runStartRef.current = 0;
    setElapsed(0);
    sessionIdRef.current = saved.id;
    itemsRef.current = saved.items;
    setItems(saved.items);
    filesRef.current = saved.files;
    messagesRef.current = saved.messages ?? [];
    seqRef.current = saved.round ?? 0;
    idRef.current = saved.items.reduce((m, i) => Math.max(m, i.id), 0);
    setError(null);
    playerRef.current!.paused = false;
    setPaused(false);
    playerRef.current!.setBuffers(saved.files);
    setSnap((prev) => ({ ...prev, buffers: saved.files, active: Object.keys(saved.files)[0] ?? null }));

    // 服务端可能重启过：用本地镜像把现场补回去（有会话就原样返回，不覆盖）
    try {
      const sync = await request("/api/session", {
        id: saved.id,
        messages: saved.messages ?? [],
        files: saved.files,
        seq: saved.round ?? 0,
      });
      seqRef.current = sync.seq ?? seqRef.current;
      if (sync.messages) messagesRef.current = sync.messages;
      if (sync.files) {
        filesRef.current = sync.files;
        playerRef.current!.setBuffers(sync.files);
      }
      note("session.restore", `服务端 seq=${sync.seq}`);
    } catch (e) {
      note("session.restore", String(e).replace(/^Error:\s*/, ""));
    }

    if (saved.pending?.length) {
      setPending(saved.pending);
      setAskIndex(saved.askIndex ?? 0);
      setAskAnswers(saved.askAnswers ?? []);
      setRunning(false);
      statusRef.current = "waiting";
      note("resume", "恢复到待回答");
      return;
    }

    setPending(null);

    if (saved.status === "running" || saved.status === "paused") {
      resetRunClock();
      setRunning(true);
      statusRef.current = "running";
      note("resume", "接着跑");
      void pump();
    } else {
      setRunning(false);
      statusRef.current = "done";
      note("resume", "恢复到已完成");
    }
  };

  const stopRun = () => {
    statusRef.current = "done";
    setRunning(false);
    saveSession();
    note("stop", "本轮结束");
  };

  /** 返回首页：停下手上的活，但把现场留着，回来可以继续 */
  const goHome = () => {
    playerRef.current!.stop();
    playerRef.current!.paused = true;
    setPaused(true);

    // 收尾动作已经在等了：这次其实做完了，不要留一张「没做完」的卡
    const after = afterPlayerRef.current;
    afterPlayerRef.current = null;
    if (after) {
      after();
      setResumable(null);
      setStarted(false);
      return;
    }

    stopRun();
    const snap = snapshot();
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...snap, status: "paused" }));
    } catch {
      /* 忽略 */
    }
    setResumable({ ...snap, status: "paused" });
    setStarted(false);
  };

  /** 真正清空：只在首页用 */
  const clearAll = () => {
    playerRef.current!.stop();
    playerRef.current!.paused = false;
    setPaused(false);
    stopRun();
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* 忽略 */
    }
    setResumable(null);
    setStarted(false);
    setSnap(EMPTY);
    setItems([]);
    itemsRef.current = [];
    setPending(null);
    setAnswer("");
    setAskIndex(0);
    setAskAnswers([]);
    setDeclined(null);
    setError(null);
    filesRef.current = {};
    startFilesRef.current = {};
    serverFilesRef.current = {};
    messagesRef.current = [];
    pendingSearchRef.current = "";
    pendingCardRef.current = null;
    pendingMessageRef.current = null;
    afterPlayerRef.current = null;
    idRef.current = 0;
    seqRef.current = 0;
    sessionIdRef.current = "";
    statusRef.current = "idle";
    runStartRef.current = 0;
    setElapsed(0);
  };

  const togglePause = () => {
    const p = playerRef.current!;
    const next = !p.paused;
    p.paused = next;
    setPaused(next);

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

  const replay = () => {
    const after = afterPlayerRef.current;
    afterPlayerRef.current = null;
    after?.();

    const files = startFilesRef.current;
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
    if (!steps.length) return;
    filesRef.current = { ...files };
    const player = playerRef.current!;
    player.paused = false;
    setPaused(false);
    player.load({
      task: "重播",
      steps,
      files: Object.keys(files).length ? files : { "": "" },
      initial: files,
      stats: { files: Object.keys(files).length, steps: steps.length, lines: 0 },
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
    messagesRef.current = [];
    seqRef.current = item.round ?? 0;
    idRef.current = items.reduce((m, i) => Math.max(m, i.id), 0);
    player.setBuffers(item.files);
    setSnap({
      ...EMPTY,
      buffers: item.files,
      active: Object.keys(item.files)[0] ?? null,
      finished: true,
    });

    let sync: {
      seq?: number;
      files?: Record<string, string>;
      messages?: ChatMessage[];
    } | null = null;

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
    messagesRef.current = sync.messages ?? [];
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

    if (resumable?.id === item.id) {
      setResumable(null);
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        /* 忽略 */
      }
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

  const liveLabel = liveStatusOf(items, pending, askIndex, running, paused);
  const runTime = runStartRef.current ? elapsedText(elapsed) : "";

  const fileList = Object.keys(filesRef.current).map((path) => ({ path, lang: langOf(path) }));
  const activeFile =
    peek ??
    (snap.active && fileList.some((f) => f.path === snap.active)
      ? snap.active
      : playerRef.current?.active ?? fileList[0]?.path ?? "");

  /** 循环正在跑时的目标文件；用户点别处时它仍然指向这里。 */
  const writingPath = running && snap.total > 0 && !snap.finished ? snap.active : null;

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

  const stepLabel = snap.banner || "";
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

            {resumable && (
              <div className="resume-card">
                <div className="resume-body">
                  <div className="resume-title">
                  {resumable.status === "waiting" ? "上次没答完" : "上次没做完"}
                </div>
                  <div className="resume-text">
                    {resumable.items.find((i) => i.kind === "user")?.ev.action === "user"
                      ? (resumable.items.find((i) => i.kind === "user")!.ev as { text: string }).text.slice(0, 40)
                      : "一个项目"}
                    <span className="resume-meta">
                      {resumable.items.length} 步 · {timeAgo(resumable.savedAt)}
                    </span>
                  </div>
                </div>
                <div className="resume-actions">
                  <button
                    className="resume-icon"
                    onClick={resume}
                    title="接着做"
                    aria-label="接着做"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className="resume-icon danger"
                    onClick={clearAll}
                    title="不要了"
                    aria-label="不要了"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            )}

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
          </div>
        </div>

        {history.length > 0 && (
          <section className="ask-history">
            <div className="history-title">
              <span>最近</span>
              <button
                className="history-clear"
                onClick={() => {
                  localStorage.removeItem(HISTORY_KEY);
                  setHistory([]);
                }}
              >
                清空
              </button>
            </div>
            <div className="history-list">
              {history.map((item) => (
                <div key={item.id} className="history-item">
                  <button className="hi-main" onClick={() => void openHistory(item)}>
                    <span className="hi-title">{item.title || "最近一次"}</span>
                    <span className="hi-meta">
                      {item.updatedAt ? `${timeAgo(item.updatedAt)} · ` : ""}
                      {Object.keys(item.files).length} 个文件
                    </span>
                  </button>
                  <div className="hi-actions">
                    <button
                      className="hi-icon"
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
                      className="hi-icon danger"
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
    );
  }

  /* ------------------------------------------------------------ 工作区 */

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo" />
          <span className="name">{projectTitle}</span>
          <span className={`status ${running ? "busy" : paused ? "paused" : pending ? "wait" : "done"}`}>
            {running ? "进行中" : paused ? "已暂停" : pending ? "等你回答" : "已完成"}
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
        <button className="ghost" onClick={replay}>重播</button>
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
                  writingPath === f.path ? "coding" : ""
                }`}
                title={f.path}
                onClick={() => setPeek(f.path)}
              >
                <span className="file-name">{f.path}</span>
                {writingPath === f.path && (
                  <span className="file-coding" aria-label="正在写" title="正在写" />
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
              className={`step-toast ${running && snap.total > 0 && !snap.finished ? "in" : ""} ${
                ghostLabel ? "changing" : ""
              } ${snap.active && activeFile !== snap.active ? "can-follow" : ""}`}
              role="button"
              tabIndex={running && snap.total > 0 && !snap.finished ? 0 : -1}
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
                <span className="st-grid">
                  {Array.from({ length: 9 }, (_, i) => (
                    <i key={i} className={`d${i}`} />
                  ))}
                </span>
              </span>
              <div className="st-stack">
                {ghostLabel && <span className="st-ghost" key={`g-${ghostLabel}`}>{ghostLabel}</span>}
                <span className="st-text" key={`n-${stepLabel}`}>{stepLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <aside className="chat">
          <button
            className={`run-status ${running ? "on" : ""} ${processOpen ? "open" : ""}`}
            onClick={() => setProcessOpen((v) => !v)}
            aria-expanded={processOpen}
            title={processOpen ? "收起过程" : "展开过程"}
          >
            <span className="run-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className={`run-label ${running ? "live" : ""}`}>{liveLabel}</span>
            {runTime && <span className="run-time">{runTime}</span>}
            <span className="run-chevron" aria-hidden />
          </button>
          <div
            className={`chat-log ${processOpen ? "" : "collapsed"}`}
            ref={logRef}
            onScroll={() => {
              const el = logRef.current;
              if (el) logStickRef.current = nearBottom(el);
            }}
          >
            {items.map((item) => (
              <TimelineItem
                key={item.id}
                item={item}
                live={item.ev.action === "ask" && pending === item.ev.questions}
                onIdea={(text) => {
                  markUsed(item.id, text);
                  void send(text);
                }}
              />
            ))}

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
          {!processOpen && (
            <div className="chat-collapsed-tip">过程已收起 · 点上方展开</div>
          )}
          <div className="chat-foot">
            {!running && !pending && items.length > 0 && (
              <div className="idle-hint">轮到你了 · 接着说一句就继续</div>
            )}
            {composer(pending ? "回答上面的问题，或直接写…" : "接着说一句…")}
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
      case "write":
        label = `写 ${ev.path} · ${ev.label}`;
        break;
      case "edit":
        label = `改 ${ev.path} · ${ev.label}`;
        break;
      case "delete":
        label = `删除 ${ev.path}`;
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

function timeAgo(ts: number) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function countLines(files: Record<string, string>) {
  return Object.values(files).reduce((n, body) => n + body.split("\n").length - 1, 0);
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

  // 正在等用户回答时，问题由下面的 ask-card 展示，时间线里先不重复
  if (ev.action === "ask" && live) return null;

  // finish 还挂着"正在收尾"时，顶部状态行已经在说，别在列表里再重复一条
  if (ev.action === "finish" && item.pending) return null;

  const kind = kindOf(ev.action);
  const summary = summaryOf(ev, item.pending);
  const detail = detailOf(ev, item.pending, picked, onIdea);
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
    say: "回话",
    decline: "拒绝",
    finish: "完成",
    error: "出错",
    user: "你",
  };
  return map[action] ?? "";
}

function summaryOf(ev: Event, pending?: boolean): ReactNode {
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
    case "say":
    case "decline":
    case "finish":
      return (
        <span className="tl-summary-text">
          {pending ? "正在收尾…" : ev.text || "完成"}
        </span>
      );
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
  pending: boolean | undefined,
  picked: string | undefined,
  onIdea?: (text: string) => void
): ReactNode | null {
  switch (ev.action) {
    case "think":
    case "say":
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

    case "write":
      return ev.code.trim() ? <CodeDetail path={ev.path} code={ev.code} /> : null;

    case "edit":
      return (
        <div className="tl-diff">
          <pre className="tl-diff-del">{ev.find}</pre>
          <pre className="tl-diff-add">{ev.replace}</pre>
        </div>
      );

    case "delete":
    case "look":
      return null;

    case "finish":
      return !pending && ev.text ? <div className="tl-text">{ev.text}</div> : null;

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

function CodeDetail({ path, code }: { path: string; code: string }) {
  const html = useMemo(() => {
    try {
      return hljs.highlight(code, { language: langOf(path) }).value;
    } catch {
      return "";
    }
  }, [path, code]);

  return (
    <div className="tl-code-wrap">
      <div className="tl-code-meta">{code.split("\n").length - 1} 行</div>
      {html ? <pre className="tl-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="tl-code">{code}</pre>}
    </div>
  );
}