import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import { Player, type Snapshot, type Step } from "./player";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);

type LessonNode = { label: string; desc: string };
type LessonStep = { label: string; focus: number; code: string };
type Lesson = {
  title: string;
  language: string;
  summary: string;
  nodes: LessonNode[];
  steps: LessonStep[];
  lines: number;
  tooLong: boolean;
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
  "数据库事务是怎么保证不出错的",
  "前端路由是怎么拦截未登录用户的",
];

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
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = 60;
    p.onUpdate = setSnap;
    p.onExhausted = () => {};

    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) window.setTimeout(() => void ask(initial), 80);

    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = (data: Lesson) => {
    const p = playerRef.current!;
    const steps: Step[] = [
      { type: "create", path: "example", banner: "准备", delay: 260 },
    ];
    data.steps.forEach((step, i) => {
      const tag = `${i}|${step.label}`;
      steps.push({ type: "banner", text: tag, delay: 300 });
      steps.push({ type: "append", path: "example", text: step.code, banner: tag });
    });
    steps.push({ type: "done", text: "讲完了" });
    p.cps = cps;
    p.paused = false;
    setPaused(false);
    p.load({
      task: data.title,
      steps,
      files: { example: "" },
      stats: { files: 1, steps: steps.length, lines: data.lines },
    });
  };

  const ask = async (text: string) => {
    const value = text.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    setLesson(null);
    playerRef.current!.stop();
    try {
      const data: Lesson = await postJson("/api/explain", { question: value });
      setLesson(data);
      play(data);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  };

  const replay = () => lesson && play(lesson);

  const togglePause = () => {
    const p = playerRef.current!;
    p.paused = !p.paused;
    setPaused(p.paused);
  };

  const code = snap.buffers["example"] ?? "";

  const [stepIndex, stepLabel] = useMemo(() => {
    const raw = snap.banner || "";
    const [i, ...rest] = raw.split("|");
    const n = Number(i);
    return [Number.isFinite(n) ? n : -1, rest.join("|") || "准备"] as const;
  }, [snap.banner]);

  const finished = snap.finished;
  const displayIndex = finished ? lesson.steps.length : Math.max(stepIndex + 1, 0);
  const displayLabel = finished ? "讲完了" : stepLabel;
  const focus =
    lesson && !finished && stepIndex >= 0 ? lesson.steps[stepIndex]?.focus ?? -1 : -1;

  const highlighted = useMemo(() => {
    if (!code) return "";
    try {
      return hljs.highlight(code, { language: langOf(lesson?.language ?? "javascript") }).value;
    } catch {
      return code;
    }
  }, [code, lesson?.language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 忽略 */
    }
  };

  /* ---------------------------------------------------------------- 提问页 */

  if (!lesson) {
    return (
      <div className="ask">
        <div className="ask-inner">
          <div className="ask-mark" />
          <h1>哪个环节没看懂？</h1>
          <p>说一个点，它用一个最小例子边写边讲给你看。</p>

          <textarea
            className="ask-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void ask(question);
            }}
            placeholder="比如：useEffect 到底什么时候执行？"
            rows={2}
            autoFocus
          />

          <button className="ask-btn" onClick={() => void ask(question)} disabled={loading || !question.trim()}>
            {loading ? "正在想例子…" : "讲给我看"}
          </button>

          <div className="ask-examples">
            {EXAMPLES.map((item) => (
              <button key={item} className="ask-chip" onClick={() => { setQuestion(item); void ask(item); }}>
                {item}
              </button>
            ))}
          </div>

          {error && <div className="ask-error">{error}</div>}
        </div>
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
          <input type="range" min={20} max={160} value={cps} onChange={(e) => {
            const v = Number(e.target.value);
            setCps(v);
            playerRef.current!.cps = v;
          }} />
          <b>{cps}</b>
        </label>
        <button className="ghost" onClick={togglePause}>{paused ? "继续" : "暂停"}</button>
        <button className="ghost" onClick={replay}>重播</button>
        <button className="primary" onClick={copy}>{copied ? "已复制" : "复制代码"}</button>
        <button className="ghost" onClick={() => { setLesson(null); playerRef.current!.stop(); }}>
          换个问题
        </button>
      </header>

      <div className="flow-wrap">
        <div className="flow">
          {lesson.nodes.map((node, i) => (
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

      <main className="stage">
        <div className="step-note">
          <span className="note-index">
            {displayIndex}/{lesson.steps.length}
          </span>
          <span className="note-text" key={displayLabel}>{displayLabel}</span>
          {lesson.tooLong && <span className="note-warn">例子偏长（{lesson.lines} 行）</span>}
        </div>

        <div className="code-card">
          <div className="code-head">
            <span className="code-lang">{lesson.language}</span>
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
      </main>
    </div>
  );
}
