import { useEffect, useMemo, useRef, useState } from "react";
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
  | { action: "user"; text: string; interrupt?: boolean };

type Item = {
  id: number;
  kind: Event["action"];
  ev: Event;
  picked?: string;
  at?: number;
  ms?: number;
};

type SavedSession = {
  id: string;
  items: Item[];
  files: Record<string, string>;
  messages: { role: string; content: string }[];
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
  updatedAt?: number;
};

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

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `请求失败 ${res.status}`);
  }
  return res.json();
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

  const messagesRef = useRef<{ role: string; content: string }[]>([]);
  const filesRef = useRef<Record<string, string>>({});
  const roundRef = useRef(0);
  const startFilesRef = useRef<Record<string, string>>({});
  const serverFilesRef = useRef<Record<string, string>>({});
  const itemsRef = useRef<Item[]>([]);
  const idRef = useRef(0);
  const sessionIdRef = useRef("");
  const answeringRef = useRef(false);
  const pausedRef = useRef(false);
  const blockedRef = useRef(false);
  const lastMsRef = useRef(0);
  const pendingCardRef = useRef<number | null>(null);
  const logsRef = useRef<{ t: number; tag: string; text: string }[]>([]);
  const runningRef = useRef(false);
  const waitingRef = useRef(false);
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
    round: roundRef.current,
    pending,
    askIndex,
    askAnswers,
    status: pausedRef.current
      ? "paused"
      : runningRef.current
        ? "running"
        : waitingRef.current
          ? "waiting"
          : "done",
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

  const markUsed = (id: number, idea: string) => {
    itemsRef.current = itemsRef.current.map((it) =>
      it.id === id ? { ...it, picked: idea } : it
    );
    setItems(itemsRef.current);
  };

  const push = (ev: Event, extra: { ms?: number } = {}) => {
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
  };

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = (s) => setSnap(s);
    p.onFinish = () => {};
    p.onExhausted = () => {
      filesRef.current = p.files();
      if (waitingRef.current) return;
      void nextRound();
    };

    let hasSaved = false;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const saved = raw ? (JSON.parse(raw) as SavedSession) : null;
      if (saved && Array.isArray(saved.items) && saved.items.length > 0) {
        setResumable(saved);
        hasSaved = true;
      }
    } catch {
      /* 读不出来就算了 */
    }

    // 有现场就别用 ?q= 重开一轮，否则会把现场覆盖掉
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && !hasSaved) window.setTimeout(() => void start(q), 80);

    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ 循环 */

  const start = async (task: string) => {
    const value = task.trim();
    if (!value) return;

    playerRef.current!.stop();
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
    sessionIdRef.current = `s-${Date.now()}`;
    roundRef.current = 0;
    waitingRef.current = false;
    messagesRef.current = [{ role: "user", content: value }];
    push({ action: "user", text: value } as Event);

    setRunning(true);
    runningRef.current = true;
    answeringRef.current = false;
    await nextRound();
  };

  const nextRound = async (pendingSearch = "") => {
    if (!runningRef.current || waitingRef.current) return;
    if (pausedRef.current) {
      blockedRef.current = true;
      note("pause", "已暂停，先不请求下一步");
      return;
    }
    if (roundRef.current >= MAX_ROUNDS) {
      finish("步数到上限，先停在这里。");
      return;
    }

    const t0 = Date.now();
    try {
      const res = await postJson("/api/step", {
        messages: messagesRef.current,
        files: filesRef.current,
        round: roundRef.current,
        pending_search: pendingSearch,
      });
      lastMsRef.current = Date.now() - t0;
      roundRef.current += 1;
      messagesRef.current = res.messages;
      // 服务端算好的结果先存着，播放完再以播放器为准同步，
      // 否则 edit 会被应用两次（第二次找不到原文就往末尾追加）
      if (res.files) serverFilesRef.current = res.files;

      await handle(res.event as Event);
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      note("loop.error", msg);
      setError(msg);
      push({ action: "error", text: msg } as Event);
      // 出错就停住，别接着跑自检（什么都没做呢）
      setRunning(false);
      runningRef.current = false;
    }
  };

  const pushStep = (ev: Event) => {
    push(ev, { ms: lastMsRef.current });
    lastMsRef.current = 0;
  };

  const handle = async (ev: Event) => {
    note(ev.action, "text" in ev && ev.text ? ev.text : "path" in ev ? ev.path : "");

    if (ev.action === "search") {
      if (!ev.results) {
        // 第一段：先把"正在搜"挂出来，再去抓结果
        pushStep(ev);
        pendingCardRef.current = itemsRef.current[itemsRef.current.length - 1].id;
        window.setTimeout(() => void nextRound(ev.query), 60);
        return;
      }
      // 第二段：结果回来，补到同一张卡上
      const id = pendingCardRef.current;
      pendingCardRef.current = null;
      if (id != null) {
        itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ev } : it));
        setItems(itemsRef.current);
      } else {
        pushStep(ev);
      }
      window.setTimeout(() => void nextRound(), 260);
      return;
    }

    if (ev.action === "think" || ev.action === "look" || ev.action === "plan") {
      pushStep(ev);
      window.setTimeout(() => void nextRound(), ev.action === "plan" ? 700 : 350);
      return;
    }

    if (ev.action === "ask") {
      pushStep(ev);
      if (Object.keys(filesRef.current).length > 0) remember(filesRef.current);
      setPending(ev.questions);
      setAskIndex(0);
      setAskAnswers([]);
      waitingRef.current = true;
      setRunning(false);
      runningRef.current = false;
      window.setTimeout(() => composerRef.current?.focus(), 60);
      return;
    }

    if (ev.action === "write" || ev.action === "edit" || ev.action === "delete") {
      pushStep(ev);
      playEvent(ev);
      return;
    }

    if (ev.action === "error") {
      pushStep(ev);
      window.setTimeout(() => void nextRound(), 400);
      return;
    }

    if (ev.action === "say") {
      stopRun();
      pushStep(ev);
      window.setTimeout(() => composerRef.current?.focus(), 60);
      return;
    }

    if (ev.action === "decline") {
      stopRun();
      setPending(null);
      // 一律留在当前界面，把话说清楚，不要把人弹到一个看不见的地方
      pushStep(ev);
      setDeclined(ev);
      return;
    }

    if (ev.action === "finish") {
      pushStep(ev);
      finish(ev.text);
      return;
    }

    // 兜底：没识别的动作也不能让循环停住
    note("loop.unknown", JSON.stringify(ev).slice(0, 120));
    push({ action: "error", text: `不认识的动作：${ev.action}` } as Event);
    window.setTimeout(() => void nextRound(), 400);
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
        window.setTimeout(() => void nextRound(), 240);
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

    setPeek(null);
    p.paused = false;
    setPaused(false);
    p.load({
      task: ev.label,
      steps: [step],
      files,
      initial: { ...filesRef.current },
      stats: { files: Object.keys(files).length, steps: 1, lines: 0 },
    });
  };

  const finish = (text: string) => {
    setRunning(false);
    runningRef.current = false;

    const files = filesRef.current;
    if (Object.keys(files).length === 0) {
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
      firstUser && firstUser.ev.action === "user"
        ? firstUser.ev.text.slice(0, 26)
        : "最近一次";
    const item: HistoryItem = {
      id: "",
      title,
      summary: summarize(files),
      items: itemsRef.current,
      base: startFilesRef.current,
      files,
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

    push({ action: "user", text: payload } as Event);
    messagesRef.current = [...messagesRef.current, { role: "user", content: payload }];
    setPending(null);
    setAskAnswers([]);
    setAskIndex(0);
    waitingRef.current = false;
    setRunning(true);
    runningRef.current = true;
    await nextRound();
  };

  const send = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    setQuestion("");

    if (pending) {
      await answerAsk(value);
      return;
    }

    if (runningRef.current) {
      messagesRef.current = [...messagesRef.current, { role: "user", content: value }];
      push({ action: "user", text: value, interrupt: true } as Event);
      return;
    }

    if (!started) {
      await start(value);
      return;
    }

    messagesRef.current = [...messagesRef.current, { role: "user", content: value }];
    push({ action: "user", text: value } as Event);
    setRunning(true);
    runningRef.current = true;
    await nextRound();
  };

  /** 从上次的现场接着干 */
  const resume = () => {
    const saved = resumable;
    if (!saved) return;

    setStarted(true);
    setResumable(null);
    sessionIdRef.current = saved.id;
    itemsRef.current = saved.items;
    setItems(saved.items);
    filesRef.current = saved.files;
    messagesRef.current = saved.messages ?? [];
    roundRef.current = saved.round ?? 0;
    idRef.current = saved.items.reduce((m, i) => Math.max(m, i.id), 0);
    setError(null);

    playerRef.current!.setBuffers(saved.files);
    setSnap((prev) => ({ ...prev, buffers: saved.files, active: Object.keys(saved.files)[0] ?? null }));

    if (saved.pending?.length) {
      setPending(saved.pending);
      setAskIndex(saved.askIndex ?? 0);
      setAskAnswers(saved.askAnswers ?? []);
      waitingRef.current = true;
      setRunning(false);
      runningRef.current = false;
      note("resume", "恢复到待回答");
      return;
    }

    waitingRef.current = false;
    setPending(null);

    if (saved.status === "running" || saved.status === "paused") {
      pausedRef.current = false;
      blockedRef.current = false;
      playerRef.current!.paused = false;
      setPaused(false);
      setRunning(true);
      runningRef.current = true;
      note("resume", "接着跑");
      void nextRound();
    } else {
      setRunning(false);
      runningRef.current = false;
      note("resume", "恢复到已完成");
    }
  };

  const stopRun = () => {
    runningRef.current = false;
    setRunning(false);
    note("stop", "手动停止");
  };

  /** 返回首页：停下手上的活，但把现场留着，回来可以继续 */
  const goHome = () => {
    playerRef.current!.stop();
    playerRef.current!.paused = true;
    pausedRef.current = true;
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
    pausedRef.current = false;
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
    setError(null);
    filesRef.current = {};
    messagesRef.current = [];
    roundRef.current = 0;
    sessionIdRef.current = "";
  };

  const togglePause = () => {
    const p = playerRef.current!;
    const next = !p.paused;
    p.paused = next;
    pausedRef.current = next;
    setPaused(next);
    note(next ? "pause" : "resume", next ? "暂停" : "继续");

    if (!next && blockedRef.current) {
      blockedRef.current = false;
      setRunning(true);
      runningRef.current = true;
      void nextRound();
    }
  };

  const replay = () => {
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
    playerRef.current!.load({
      task: "重播",
      steps,
      files: Object.keys(files).length ? files : { "": "" },
      initial: files,
      stats: { files: Object.keys(files).length, steps: steps.length, lines: 0 },
    });
  };

  /* ------------------------------------------------------------ 展示 */

  const firstUserItem = itemsRef.current.find(
    (i) => i.kind === "user" && i.ev.action === "user"
  );
  const projectTitle =
    firstUserItem && firstUserItem.ev.action === "user"
      ? firstUserItem.ev.text.slice(0, 22)
      : "新项目";

  const fileList = Object.keys(filesRef.current).map((path) => ({ path, lang: langOf(path) }));
  const activeFile =
    peek ??
    (snap.active && fileList.some((f) => f.path === snap.active)
      ? snap.active
      : playerRef.current?.active ?? fileList[0]?.path ?? "");

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
        placeholder={placeholder}
        rows={1}
        autoFocus
      />
      <button
        className="composer-send"
        onClick={() => void send(question)}
        disabled={!question.trim()}
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
                <div className="resume-title">上次没做完</div>
                <div className="resume-text">
                  {resumable.items.find((i) => i.kind === "user")?.ev.action === "user"
                    ? (resumable.items.find((i) => i.kind === "user")!.ev as { text: string }).text.slice(0, 40)
                    : "一个项目"}
                  <span className="resume-meta">
                    {resumable.items.length} 步 · {timeAgo(resumable.savedAt)}
                  </span>
                </div>
                <div className="resume-actions">
                  <button className="primary" onClick={resume}>接着做</button>
                  <button className="ghost" onClick={clearAll}>不要了</button>
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
              {history.map((item, i) => (
                <button
                  key={i}
                  className="history-item"
                  onClick={() => {
                    setStarted(true);
                    sessionIdRef.current = item.id;
                    setItems(item.items);
                    itemsRef.current = item.items;
                    filesRef.current = item.files;
                    startFilesRef.current = item.base ?? {};
                    playerRef.current!.setBuffers(item.files);
                    setDeclined(null);
                  }}
                >
                  <span className="hi-title">{item.title || "最近一次"}</span>
                  <span className="hi-meta">
                    {item.updatedAt ? `${timeAgo(item.updatedAt)} · ` : ""}
                    {Object.keys(item.files).length} 个文件
                  </span>
                </button>
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
          <span className={`status ${running ? "busy" : pending ? "wait" : "done"}`}>
            {running ? "进行中" : pending ? "等你回答" : "已完成"}
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
        <button className="ghost" onClick={copy}>{copied ? "已复制" : "复制"}</button>
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
                className={`file ${activeFile === f.path ? "on" : ""}`}
                title={f.path}
                onClick={() => setPeek(f.path)}
              >
                {f.path}
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
                  <span className={`caret ${paused || snap.finished ? "idle" : ""}`} />
                </>
              ) : (
                <div className="code-empty stage-waiting">
                  <span className="stage-dot" />
                  <span>{running ? "它在想接下来做什么…" : "还没有代码"}</span>
                </div>
              )}
            </div>

            <div className={`step-toast ${running && snap.total > 0 && !snap.finished ? "in" : ""} ${ghostLabel ? "changing" : ""}`}>
              <span className="st-tile">
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M4 12h13M11 6l6 6-6 6" />
                </svg>
              </span>
              <div className="st-stack">
                {ghostLabel && <span className="st-ghost" key={`g-${ghostLabel}`}>{ghostLabel}</span>}
                <span className="st-text" key={`n-${stepLabel}`}>{stepLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <aside className="chat">
          <div className="chat-head">过程</div>
          <div
            className="chat-log"
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

            {running && !pending && <div className="bubble assistant typing">…</div>}
          </div>
          <div className="chat-foot">
            {!running && !pending && items.length > 0 && (
              <div className="idle-hint">轮到你了 · 接着说一句就继续</div>
            )}
            {composer(pending ? "回答上面的问题，或直接写…" : "可以随时插话")}
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

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
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
  const picked = item.picked;
  const ev = item.ev;

  if (ev.action === "user") {
    return (
      <div className="tl user">
        {ev.interrupt && <span className="user-tag">插话</span>}
        <span>{ev.text}</span>
      </div>
    );
  }

  if (ev.action === "think") {
    return <div className="tl think">{ev.text}</div>;
  }

  if (ev.action === "look") {
    return <div className="tl look">查看 {ev.path || "项目根目录"}</div>;
  }

  if (ev.action === "search") {
    const done = Boolean(ev.results);
    return (
      <div className="tl search">
        <div className="ws-head">
          <span className={`ws-ring ${done ? "done" : ""}`} />
          <span className="ws-query">{ev.query}</span>
          {done && <span className="ws-count">{ev.results!.length} 条</span>}
        </div>

        {!done && <div className="ws-waiting">正在搜…</div>}

        {done &&
          (ev.results!.length > 0 ? (
            <div className="ws-grid">
              {ev.results!.slice(0, 4).map((r, i) => (
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
          ))}
      </div>
    );
  }

  if (ev.action === "plan") {
    return (
      <div className="tl plan">
        {ev.steps.map((s, i) => (
          <div key={i} className="plan-step">
            <span className="plan-i">{i + 1}</span>
            {s}
          </div>
        ))}
      </div>
    );
  }

  if (ev.action === "ask") {
    if (live) return null;
    return (
      <div className="tl ask-done">
        {ev.questions.map((q, i) => (
          <div key={i} className="ask-done-q">
            {q.question}
            {q.options.length > 0 && <div className="ask-done-opts">{q.options.join(" · ")}</div>}
          </div>
        ))}
      </div>
    );
  }

  if (ev.action === "write") {
    return (
      <div className="tl file-op">
        <span className="op-tag new">新建</span>
        <span className="op-path">{ev.path}</span>
        <span className="op-label">{ev.label}</span>
      </div>
    );
  }

  if (ev.action === "edit") {
    return (
      <div className="tl file-op">
        <span className="op-tag edit">修改</span>
        <span className="op-path">{ev.path}</span>
        <span className="op-label">{ev.label}</span>
      </div>
    );
  }

  if (ev.action === "delete") {
    return (
      <div className="tl file-op">
        <span className="op-tag del">删除</span>
        <span className="op-path">{ev.path}</span>
        <span className="op-label">{ev.label}</span>
      </div>
    );
  }

  if (ev.action === "say") {
    return <div className="tl say">{ev.text}</div>;
  }

  if (ev.action === "decline") {
    return (
      <div className="tl decline">
        <div>{ev.text}</div>
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
      </div>
    );
  }

  if (ev.action === "error") {
    return <div className="tl err">{ev.text}</div>;
  }

  return (
    <div className="tl finish">
      {ev.text || "完成"}
    </div>
  );
}