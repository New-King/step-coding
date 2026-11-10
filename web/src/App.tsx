import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import { Player, type Snapshot, type Step } from "./player";
import { downloadZip } from "./zip";

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

const EXAMPLES = [
  "React 的 useEffect 到底什么时候执行",
  "后端的中间件是怎么串起来的",
  "帮我写一个登录页面",
  "Docker 的镜像分层是怎么回事",
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
  const [lesson, setLesson] = useState<Lesson | null>(null);
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

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = setSnap;
    p.onExhausted = () => {};

    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) window.setTimeout(() => void ask(initial), 80);

    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const open = (data: Lesson) => {
    setLesson(data);
    play(data);
  };

  const ask = async (text: string) => {
    const value = text.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    playerRef.current!.stop();
    try {
      const data: Lesson = await postJson("/api/explain", { question: value });
      const withQuestion = { ...data, question: value };
      setLesson(withQuestion);
      play(withQuestion);
      remember(withQuestion);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const backToAsk = () => {
    playerRef.current!.stop();
    setLesson(null);
    setSnap(EMPTY);
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

    // 先冻住，避免把正在敲的半行导出去
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

  /* ---------------------------------------------------------------- 提问页 */

  if (!lesson) {
    return (
      <div className="ask">
        <div className="ask-hero">
          <div className="ask-inner">
            <div className="ask-mark" />
            <h1>想弄懂什么？</h1>
            <p>说一句，它写个最小的例子给你看。</p>

            <div className="ask-examples">
              {EXAMPLES.map((item) => (
                <button
                  key={item}
                  className="ask-chip"
                  onClick={() => {
                    setQuestion(item);
                    void ask(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="composer">
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void ask(question);
                  }
                }}
                placeholder="比如：useEffect 什么时候执行，或者写个登录页"
                rows={1}
                autoFocus
              />
              <button
                className="composer-send"
                onClick={() => void ask(question)}
                disabled={loading || !question.trim()}
                title="发送"
              >
                {loading ? "…" : "→"}
              </button>
            </div>

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
                  onClick={() => open(item)}
                >
                  <span className="hi-title">{item.title}</span>
                  <span className="hi-meta">
                    {item.files.length} 个文件 · {item.lines} 行
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- 讲解页 */

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo" />
          <span className="name">{lesson.title}</span>
        </div>
        <div className="task">{lesson.summary}</div>
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
        <button className="primary" onClick={exportZip} disabled={!hasContent} title="暂停时也可以导出">
          导出代码
        </button>
        <button className="ghost" onClick={backToAsk}>换个问题</button>
      </header>

      <main className="workspace">
        <aside className="files">
          <div className="files-title">
            文件
            <span>{lesson.files.length}</span>
          </div>
          {lesson.files.map((f) => (
            <button
              key={f.path}
              className={`file ${activeFile === f.path ? "on" : ""}`}
              title={f.path}
              onClick={() => setPeek(f.path)}
            >
              {f.path}
            </button>
          ))}
          <div className="files-foot">{lesson.lines} 行</div>
        </aside>

        <section className="pane">
          {lesson.flow.length >= 2 && (
            <div className="flow-wrap">
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
        </section>
      </main>
    </div>
  );
}
