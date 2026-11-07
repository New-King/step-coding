import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import { Player, type Snapshot, type Step } from "./player";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);

const EMPTY: Snapshot = {
  buffers: {},
  active: null,
  banner: "准备开始",
  say: "",
  stepIndex: 0,
  total: 0,
  typing: false,
  finished: false,
};

type Msg = { role: "user" | "agent"; text: string };

type Written = {
  path: string;
  say: string;
  sections: { note: string; code: string }[];
  content: string;
};

function langOf(path: string) {
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".html")) return "xml";
  return "javascript";
}

/** 一个文件 → 播放步骤：每写完一段，横幅换一次。 */
function stepsForFile(w: Written): Step[] {
  const out: Step[] = [
    { type: "create", path: w.path, banner: `正在创建 ${w.path}`, delay: 420 },
  ];
  for (const sec of w.sections) {
    out.push({ type: "banner", text: sec.note, delay: 320 });
    out.push({ type: "append", path: w.path, text: sec.code, banner: sec.note });
  }
  return out;
}

function previewHtml(files: Record<string, string>) {
  const html = files["index.html"] ?? "";
  const style = files["style.css"] ?? "";
  const js = Object.entries(files).find(([k]) => k.endsWith(".js"))?.[1] ?? "";
  return html
    .replace(/<link[^>]*\.css[^>]*>/, `<style>${style}</style>`)
    .replace(/<script[^>]*\.js[^>]*><\/script>/, `<script>${js}<\/script>`);
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

  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 55;
  });
  const [showPreview, setShowPreview] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const codeRef = useRef<HTMLDivElement | null>(null);
  const taskRef = useRef("");
  const planRef = useRef<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const phaseRef = useRef<"idle" | "planning" | "writing" | "done">("idle");
  const autoRan = useRef(false);

  useEffect(() => {
    const p = playerRef.current!;
    p.cps = cps;
    p.onUpdate = (s) => {
      setSnap(s);
      setPaths(Object.keys(s.buffers).filter((k) => (s.buffers[k] ?? "").length > 0));
    };
    p.onFinish = () => setBusy(false);
    p.onExhausted = () => {
      if (phaseRef.current !== "writing") return;
      if (queueRef.current.length > 0) void writeNext(queueRef.current.shift()!);
      else finishUp();
    };
    const autoTask = new URLSearchParams(window.location.search).get("task");
    if (autoTask && !autoRan.current) {
      autoRan.current = true;
      window.setTimeout(() => void start(autoTask), 150);
    }

    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [snap.buffers, snap.active]);

  async function writeNext(path: string) {
    const p = playerRef.current!;
    setThinking(true);
    try {
      const data: Written = await postJson("/api/write", {
        task: taskRef.current,
        path,
        plan: planRef.current,
        files: p.files(),
      });
      setMessages((m) => [...m, { role: "agent", text: data.say || `正在写 ${path}` }]);
      p.push(stepsForFile(data));
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/, "");
      setError(text);
      setMessages((m) => [...m, { role: "agent", text: `出错了：${text}` }]);
      phaseRef.current = "done";
      p.push([{ type: "done", text: "中断" }]);
    } finally {
      setThinking(false);
    }
  }

  function finishUp() {
    phaseRef.current = "done";
    playerRef.current!.push([
      { type: "run", cmd: "open index.html", banner: "正在打开预览" },
      { type: "done", text: "写完了，可以玩了。" },
    ]);
  }

  async function start(task: string) {
    const p = playerRef.current!;
    setMessages((m) => [...m, { role: "user", text: task }]);
    setBusy(true);
    setError(null);
    setPaths([]);
    taskRef.current = task;
    setShowPreview(false);
    p.resetForTask();
    phaseRef.current = "planning";

    setThinking(true);
    try {
      const data = await postJson("/api/plan-files", { task });

      // 不是活儿：只回一句，别开工
      if (data.intent === "chat") {
        setMessages((m) => [...m, { role: "agent", text: data.reply }]);
        setBusy(false);
        phaseRef.current = "idle";
        return;
      }

      planRef.current = data.files as string[];
      queueRef.current = [...planRef.current];
      setMessages((m) => [
        ...m,
        { role: "agent", text: `我先写这几个文件：${planRef.current.join("、")}` },
      ]);
      phaseRef.current = "writing";
      const first = queueRef.current.shift();
      if (!first) {
        finishUp();
        return;
      }
      await writeNext(first);
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/, "");
      setError(text);
      setMessages((m) => [...m, { role: "agent", text: `出错了：${text}` }]);
      setBusy(false);
      phaseRef.current = "done";
      p.push([{ type: "done", text: "中断" }]);
    } finally {
      setThinking(false);
    }
  }

  const active = snap.active;
  const text = active ? snap.buffers[active] ?? "" : "";

  const highlighted = useMemo(() => {
    if (!active || !text) return "";
    try {
      return hljs.highlight(text, { language: langOf(active) }).value;
    } catch {
      return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
    }
  }, [active, text]);

  const toggle = () => {
    const p = playerRef.current!;
    p.paused = !p.paused;
    setPaused(p.paused);
  };

  const onSpeed = (value: number) => {
    setCps(value);
    playerRef.current!.cps = value;
  };

  const progress = snap.total ? Math.round((snap.stepIndex / snap.total) * 100) : 0;

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="logo" />
          <span className="name">Step Coding</span>
          <span className="task">{taskRef.current || "等你给一个任务"}</span>
        </div>

        <div className="controls">
          <span className="counter">
            {snap.stepIndex}/{snap.total}
          </span>
          <label className="speed">
            速度
            <input
              type="range"
              min={15}
              max={160}
              value={cps}
              onChange={(e) => onSpeed(Number(e.target.value))}
            />
            <span className="cps">{cps}</span>
          </label>
          <button className="ghost" onClick={toggle} disabled={!snap.total}>
            {paused ? "继续" : "暂停"}
          </button>
          {snap.finished && paths.includes("index.html") && (
            <button className="primary run" onClick={() => setShowPreview(true)}>
              查看结果
            </button>
          )}
        </div>
      </header>

      <div className={`banner ${snap.finished ? "done" : ""}`}>
        <span className={`pulse ${paused || thinking ? "paused" : ""}`} />
        <span className="banner-text">{thinking ? "思考下一步…" : snap.banner}</span>
        <span className="banner-progress">
          <i style={{ width: `${progress}%` }} />
        </span>
      </div>

      <main className="body">
        <aside className="tree">
          <div className="tree-title">文件</div>
          {paths.length === 0 && <div className="tree-empty">还没有文件</div>}
          {paths.map((path) => (
            <div
              key={path}
              className={`file ${active === path ? "active" : ""} ${
                (snap.buffers[path] ?? "").length > 0 ? "has" : ""
              }`}
            >
              <span className="dot" />
              <span className="fname">{path}</span>
            </div>
          ))}
        </aside>

        <section className="editor">
          <div className="tabs">
            {paths.map((path) => (
              <div key={path} className={`tab ${active === path ? "active" : ""}`}>
                {path}
              </div>
            ))}
          </div>
          <div className="code" ref={codeRef}>
            {text ? (
              <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <div className="placeholder">
                在右边描述你要做的东西，它会一个文件一个文件写出来
              </div>
            )}
            <span className={`caret ${paused || snap.finished ? "idle" : ""}`} />
          </div>
        </section>

        <aside className="chat">
          <div className="chat-head">对话</div>
          <div className="chat-log">
            {messages.length === 0 && (
              <div className="chat-hint">
                试试：
                <button className="chip" onClick={() => void start("做一个贪吃蛇小游戏")}>
                  做一个贪吃蛇
                </button>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            {thinking && <div className="msg agent thinking">正在想…</div>}
          </div>
          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = draft.trim();
              if (!value || busy) return;
              setDraft("");
              void start(value);
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={busy ? "正在写…" : "描述你要做的东西"}
              disabled={busy}
            />
            <button disabled={busy || !draft.trim()}>{busy ? "…" : "发送"}</button>
          </form>
          {error && <div className="chat-error">{error}</div>}
        </aside>
      </main>

      {showPreview && (
        <div className="overlay" onClick={() => setShowPreview(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>运行结果</span>
              <button className="ghost" onClick={() => setShowPreview(false)}>
                关闭
              </button>
            </div>
            <iframe title="preview" sandbox="allow-scripts" srcDoc={previewHtml(snap.buffers)} />
          </div>
        </div>
      )}
    </div>
  );
}
