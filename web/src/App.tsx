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

type LessonNode = { label: string; desc: string };
type LessonFile = { path: string; lang: string };
type LessonStep = { label: string; file: string; focus: number; code: string };
type Lesson = {
  title: string;
  summary: string;
  kind: string;
  files: LessonFile[];
  flow: LessonNode[];
  steps: LessonStep[];
  lines: number;
  tooLong: boolean;
  question?: string;
};

type Msg = { role: "user" | "assistant" | "log"; text: string };

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

const HISTORY_KEY = "stepcoding.history";

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
  const [messages, setMessages] = useState<Msg[]>([]);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [started, setStarted] = useState(false);
  const [history, setHistory] = useState<Lesson[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  });
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  const [copied, setCopied] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);

  const lessonRef = useRef<Lesson | null>(null);
  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const fixRoundRef = useRef(0);
  const loggedRef = useRef(-1);
  const finishedRef = useRef(false);

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = (snap) => {
      setSnap(snap);
      logProgress(snap.banner);
    };
    p.onFinish = () => finishLesson();
    p.onExhausted = () => {};

    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) window.setTimeout(() => void send(initial), 80);

    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 每走到一步，就在右边记一行——右边是过程，不是结论。 */
  const logProgress = (banner: string) => {
    const data = lessonRef.current;
    if (!data) return;
    const match = /^(\d+)\|/.exec(banner || "");
    if (!match) return;
    const idx = Number(match[1]);
    if (idx <= loggedRef.current) return;

    const fresh: Msg[] = [];
    for (let i = loggedRef.current + 1; i <= idx; i += 1) {
      const step = data.steps[i];
      if (step) fresh.push({ role: "log", text: `${step.file}　${step.label}` });
    }
    loggedRef.current = idx;
    if (fresh.length) setMessages((m) => [...m, ...fresh]);
  };

  /** 播完了：自己检查一遍；查出问题就回去修，修完再查。 */
  const finishLesson = async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;

    const data = lessonRef.current;
    if (!data) return;
    const files = playerRef.current!.files();
    const issues = checkFiles(files);

    setMessages((m) => [...m, { role: "log", text: `写完　${summarize(files)}` }]);

    if (issues.length === 0) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "检查了一遍：引用对得上，类名也都对得上，没发现问题。" },
      ]);
      return;
    }

    const list = issues.map((i) => `· ${i.file}：${i.text}`).join("\n");

    if (fixRoundRef.current >= 2) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `还是有问题，先停在这里：\n${list}` },
      ]);
      return;
    }

    fixRoundRef.current += 1;
    setMessages((m) => [
      ...m,
      { role: "assistant", text: `检查查出 ${issues.length} 处问题：\n${list}` },
      { role: "log", text: "回去改这几处" },
    ]);

    historyRef.current.push({
      role: "user",
      content: `你刚写出来的文件有问题，请改好，重新给出完整文件：\n${list}`,
    });

    setLoading(true);
    try {
      const res = await postJson("/api/turn", {
        messages: historyRef.current,
        current: data,
      });
      if (res.action === "build") {
        const next: Lesson = { ...res.lesson };
        historyRef.current.push({ role: "assistant", content: `改好了：${next.title}` });
        setLesson(next);
        play(next);
      } else {
        historyRef.current.push({ role: "assistant", content: res.text });
        setMessages((m) => [...m, { role: "assistant", text: res.text }]);
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", text: `想改但没改成：${String(e).replace(/^Error:\s*/, "")}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const remember = (data: Lesson) => {
    setHistory((prev) => {
      const next = [data, ...prev.filter((x) => x.title !== data.title)].slice(0, 6);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* 存不下就算了 */
      }
      return next;
    });
  };

  const play = (data: Lesson) => {
    const p = playerRef.current!;
    const files: Record<string, string> = {};
    data.files.forEach((f) => {
      files[f.path] = "";
    });

    const steps: Step[] = [
      { type: "create", path: data.files[0].path, banner: "准备", delay: 200 },
    ];
    data.steps.forEach((step, i) => {
      const tag = `${i}|${step.label}`;
      steps.push({ type: "banner", text: tag, delay: 260 });
      steps.push({ type: "append", path: step.file, text: step.code, banner: tag });
    });
    steps.push({ type: "done", text: "讲完了" });

    lessonRef.current = data;
    loggedRef.current = -1;
    finishedRef.current = false;
    setPeek(null);
    p.cps = cps;
    p.paused = false;
    setPaused(false);
    p.load({
      task: data.title,
      steps,
      files,
      stats: { files: data.files.length, steps: steps.length, lines: data.lines },
    });
  };

  /** 一轮对话：先说，还是直接写。 */
  const send = async (text: string) => {
    const value = text.trim();
    if (!value || loading) return;

    setStarted(true);
    const revising = lesson !== null;
    if (!revising) {
      historyRef.current = [];
      fixRoundRef.current = 0;
    }
    historyRef.current.push({ role: "user", content: value });
    const next: Msg[] = [...messages, { role: "user", text: value }];
    setMessages(next);
    setQuestion("");
    setError(null);
    setLoading(true);

    // 正在播的话先停住，他要说话了
    if (lesson) {
      playerRef.current!.paused = true;
      setPaused(true);
    }

    try {
      const res = await postJson("/api/turn", {
        messages: historyRef.current,
        current: lesson,
      });

      if (res.action === "reply") {
        historyRef.current.push({ role: "assistant", content: res.text });
        setMessages([...next, { role: "assistant", text: res.text }]);
      } else {
        const data: Lesson = { ...res.lesson, question: value };
        historyRef.current.push({ role: "assistant", content: `写好了：${data.title}` });
        fixRoundRef.current = 0;
        setLesson(data);
        play(data);
        remember(data);
        setMessages(
          revising ? [...next, { role: "log", text: "按你说的重写一版" }] : next
        );
      }
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, "");
      setError(msg);
      setMessages([...next, { role: "assistant", text: msg }]);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    playerRef.current!.stop();
    setLesson(null);
    setStarted(false);
    setSnap(EMPTY);
    setMessages([]);
    setError(null);
    setPaused(false);
  };

  const replay = () => lesson && play(lesson);

  const togglePause = () => {
    const p = playerRef.current!;
    p.paused = !p.paused;
    setPaused(p.paused);
  };

  const fileList = lesson?.files ?? [];
  const activeFile =
    peek ??
    (snap.active && fileList.some((f) => f.path === snap.active)
      ? snap.active
      : fileList[0]?.path ?? "");

  const code = activeFile ? snap.buffers[activeFile] ?? "" : "";
  const langName = fileList.find((f) => f.path === activeFile)?.lang ?? "javascript";

  const [stepIndex, stepLabel] = useMemo(() => {
    const raw = snap.banner || "";
    const [i, ...rest] = raw.split("|");
    const n = Number(i);
    return [Number.isFinite(n) ? n : -1, rest.join("|") || "准备"] as const;
  }, [snap.banner]);

  const finished = snap.finished;
  const totalSteps = lesson?.steps.length ?? 0;
  const displayIndex = finished ? totalSteps : Math.max(stepIndex + 1, 0);
  const displayLabel = finished ? "讲完了" : stepLabel;
  const focus =
    lesson && !finished && stepIndex >= 0 ? lesson.steps[stepIndex]?.focus ?? -1 : -1;

  const highlighted = useMemo(() => {
    if (!code) return "";
    try {
      return hljs.highlight(code, { language: langOf(langName) }).value;
    } catch {
      return code;
    }
  }, [code, langName]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 忽略 */
    }
  };

  const hasContent = Object.values(snap.buffers).some((v) => (v ?? "").trim().length > 0);

  const exportZip = () => {
    if (!lesson) return;
    const p = playerRef.current!;
    if (!p.paused) {
      p.paused = true;
      setPaused(true);
    }
    const entries = lesson.files
      .map((f) => ({ path: f.path, content: snap.buffers[f.path] ?? "" }))
      .filter((e) => e.content.trim().length > 0);
    const safe = (lesson.title || "step-coding").replace(/[/\\:*?"<>|]/g, "-");
    downloadZip(`${safe}.zip`, entries);
  };

  const composer = (
    <div className={`composer ${loading ? "busy" : ""}`}>
      <textarea
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send(question);
          }
        }}
        placeholder={lesson ? "说哪里不对，或者问这是什么意思" : "说一句…"}
        rows={1}
        autoFocus
      />
      <button
        className="composer-send"
        onClick={() => void send(question)}
        disabled={loading || !question.trim()}
        title="发送"
      >
        {loading ? "…" : "→"}
      </button>
    </div>
  );

  /* ---------------------------------------------------------- 欢迎页（独立页面） */

  if (!started) {
    return (
      <div className="ask">
        <div className="ask-hero">
          <div className="ask-inner">
            <div className="ask-mark" />
            <h1>想弄懂什么？</h1>
            <p>说一句，它写个最小的例子给你看。</p>
            <div className="ask-examples">
              {EXAMPLES.map((item) => (
                <button key={item.ask} className="ask-chip" onClick={() => void send(item.ask)}>
                  {item.label}
                </button>
              ))}
            </div>
            {composer}
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
                <button
                  key={item.title + (item.question ?? "")}
                  className="history-item"
                  onClick={() => {
                    setStarted(true);
                    setMessages([
                      { role: "user", text: item.question ?? item.title },
                      { role: "assistant", text: item.summary },
                    ]);
                    setLesson(item);
                    play(item);
                  }}
                >
                  <span className="hi-title">{item.title}</span>
                  <span className="hi-meta">{item.files.length} 个文件 · {item.lines} 行</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  const branding = lesson?.title ?? "Step Coding";
  const subtitle = lesson?.summary ?? "说一句，它写个最小的例子给你看。";

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo" />
          <span className="name">{branding}</span>
        </div>
        <div className="task">{subtitle}</div>
        <div className="spacer" />

        {lesson && (
          <>
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
            <button className="primary" onClick={exportZip} disabled={!hasContent} title="暂停时也可以导出">
              导出代码
            </button>
            <button className="ghost" onClick={reset}>清空</button>
          </>
        )}
      </header>

      <main className="workspace">
        <aside className="files">
          <div className="files-title">
            文件
            <span>{lesson ? lesson.files.length : 0}</span>
          </div>
          {lesson ? (
            lesson.files.map((f) => (
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
          <div className="files-foot">{lesson ? `${lesson.lines} 行` : "—"}</div>
        </aside>

        <section className="pane">
          {lesson ? (
            <>
              {lesson.flow.length >= 2 && (
                <div className="flow-wrap">
                  <div className="flow-caption">这几部分怎么串起来</div>
                  <div className="flow">
                    {lesson.flow.map((node, i) => (
                      <div key={`${node.label}-${i}`} className="flow-item">
                        {i > 0 && <span className={`arrow ${focus === i ? "on" : ""}`}>→</span>}
                        <div className={`node ${focus === i ? "on" : ""}`}>
                          <div className="node-label">{node.label}</div>
                          <div className="node-desc">{node.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="step-note">
                <span className="note-index">
                  {displayIndex}/{totalSteps}
                </span>
                <span className="note-text" key={displayLabel}>{displayLabel}</span>
                {lesson.tooLong && <span className="note-warn">例子偏长（{lesson.lines} 行）</span>}
              </div>

              <div className="code-card">
                <div className="code-head">
                  <span className="code-path">{activeFile}</span>
                  <span className="code-lines">{code ? code.split("\n").length - 1 : 0} 行</span>
                </div>
                <div className="code">
                  {code ? (
                    <>
                      <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
                      <span className={`caret ${paused || snap.finished ? "idle" : ""}`} />
                    </>
                  ) : (
                    <div className="code-empty">准备中…</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="stage-empty">
              <span className="stage-dot" />
              <div className="stage-hint">正在写…</div>
            </div>
          )}
        </section>

        <aside className="chat">
          <div className="chat-head">对话</div>
          <div className="chat-log">
            {messages.length === 0 && (
              <div className="chat-intro">
                {history.length > 0 && (
                  <>
                    <div className="chat-intro-sub recent">最近</div>
                    {history.map((item) => (
                      <button
                        key={item.title + (item.question ?? "")}
                        className="history-item"
                        onClick={() => {
                          setMessages([
                            { role: "user", text: item.question ?? item.title },
                            { role: "assistant", text: item.summary },
                          ]);
                          setLesson(item);
                          play(item);
                        }}
                      >
                        <span className="hi-title">{item.title}</span>
                        <span className="hi-meta">{item.lines} 行</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text}
              </div>
            ))}
            {loading && <div className="bubble assistant typing">…</div>}
            {error && <div className="bubble error">{error}</div>}
          </div>
          <div className="chat-foot">{composer}</div>
        </aside>
      </main>
    </div>
  );
}
