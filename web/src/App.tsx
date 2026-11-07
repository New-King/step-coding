import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import { Player, type Plan, type Snapshot } from "./player";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);

const LANG: Record<string, string> = {
  "index.html": "xml",
  "style.css": "css",
  "game.js": "javascript",
};

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

function previewHtml(files: Record<string, string>) {
  const html = files["index.html"] ?? "";
  const style = files["style.css"] ?? "";
  const script = files["game.js"] ?? "";
  return html
    .replace(/<link[^>]*style\.css[^>]*>/, `<style>${style}</style>`)
    .replace(/<script[^>]*game\.js[^>]*><\/script>/, `<script>${script}<\/script>`);
}

export default function App() {
  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) playerRef.current = new Player();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const initialCps = (() => {
    const v = Number(new URLSearchParams(window.location.search).get("cps"));
    return Number.isFinite(v) && v > 0 ? v : 45;
  })();
  const [paused, setPaused] = useState(false);
  const [cps, setCps] = useState(initialCps);
  const [showPreview, setShowPreview] = useState(false);
  const codeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch("/api/plan")
      .then((r) => r.json())
      .then((data: Plan) => {
        setPlan(data);
        const p = playerRef.current!;
        p.onUpdate = setSnap;
        p.cps = initialCps;
        p.load(data);
        const at = Number(new URLSearchParams(window.location.search).get("at"));
        if (Number.isFinite(at) && at > 0) {
          p.paused = true;
          setPaused(true);
          p.seekTo(at);
        }
      });
    return () => playerRef.current?.stop();
  }, []);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight;
    }
  }, [snap.buffers, snap.active]);

  const active = snap.active;
  const text = active ? snap.buffers[active] ?? "" : "";

  const highlighted = useMemo(() => {
    if (!active || !text) return "";
    try {
      return hljs.highlight(text, { language: LANG[active] ?? "javascript" }).value;
    } catch {
      return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
    }
  }, [active, text]);

  const toggle = () => {
    const p = playerRef.current!;
    p.paused = !p.paused;
    setPaused(p.paused);
  };

  const replay = () => {
    const p = playerRef.current!;
    p.paused = false;
    setPaused(false);
    p.reset();
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
          <span className="task">{plan?.task ?? "载入中…"}</span>
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
              max={140}
              value={cps}
              onChange={(e) => onSpeed(Number(e.target.value))}
            />
            <span className="cps">{cps}</span>
          </label>
          <button className="ghost" onClick={replay}>
            重播
          </button>
          <button className="primary" onClick={toggle}>
            {paused ? "继续" : "暂停"}
          </button>
          {snap.finished && (
            <button className="primary run" onClick={() => setShowPreview(true)}>
              查看结果
            </button>
          )}
        </div>
      </header>

      <div className={`banner ${snap.finished ? "done" : ""}`}>
        <span className={`pulse ${paused ? "paused" : ""}`} />
        <span className="banner-text">{snap.banner}</span>
        <span className="banner-progress">
          <i style={{ width: `${progress}%` }} />
        </span>
      </div>

      <main className="body">
        <aside className="tree">
          <div className="tree-title">文件</div>
          {Object.keys(plan?.files ?? {}).map((path) => (
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
          <div className="tree-foot">
            共 {plan?.stats.files ?? 0} 个文件 · {plan?.stats.lines ?? 0} 行
          </div>
        </aside>

        <section className="editor">
          <div className="tabs">
            {Object.keys(plan?.files ?? {}).map((path) => (
              <div key={path} className={`tab ${active === path ? "active" : ""}`}>
                {path}
              </div>
            ))}
          </div>
          <div className="code" ref={codeRef}>
            <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
            <span className={`caret ${paused || snap.finished ? "idle" : ""}`} />
          </div>
        </section>
      </main>

      <footer className="say">
        <span className="say-tag">agent</span>
        <span className="say-text">{snap.say || "等待开始…"}</span>
      </footer>

      {showPreview && (
        <div className="overlay" onClick={() => setShowPreview(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>运行结果</span>
              <button className="ghost" onClick={() => setShowPreview(false)}>
                关闭
              </button>
            </div>
            <iframe
              title="preview"
              sandbox="allow-scripts"
              srcDoc={previewHtml(snap.buffers)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
