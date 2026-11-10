import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import { Player, type Snapshot, type Step } from "./player";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);

const WS_KEY = "stepcoding.workspace";

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

type WsFile = { path: string; name: string; depth: number; type: "file" | "dir"; size?: number };
type Ws = {
  root: string | null;
  name?: string;
  files: WsFile[];
  total: number;
  truncated: boolean;
};

type AgentEvent = {
  type: string;
  path?: string;
  from?: string;
  to?: string;
  target?: string;
  cmd?: string;
  output?: string;
  exit?: number;
  ok?: boolean;
  error?: string;
  text?: string;
  created?: boolean;
  sections?: { note: string; code: string }[];
};

/** 工具调用 → 播放步骤。这里决定"看得见什么"。 */
function eventsToSteps(events: AgentEvent[]): { steps: Step[]; logs: string[] } {
  const steps: Step[] = [];
  const logs: string[] = [];

  for (const e of events) {
    if (e.type === "look") {
      steps.push({ type: "banner", text: `查看 ${e.target || "."}`, delay: 200 });
    } else if (e.type === "mkdir") {
      if (e.ok) {
        steps.push({ type: "banner", text: `创建目录 ${e.path}`, delay: 380 });
        logs.push(`新建目录 ${e.path}`);
      } else {
        logs.push(`建目录失败：${e.error}`);
      }
    } else if (e.type === "write") {
      steps.push({
        type: "create",
        path: e.path || "",
        banner: `${e.created ? "创建" : "更新"} ${e.path}`,
        delay: 340,
      });
      for (const sec of e.sections ?? []) {
        steps.push({ type: "banner", text: sec.note, delay: 280 });
        steps.push({ type: "append", path: e.path || "", text: sec.code, banner: sec.note });
      }
      logs.push(`${e.created ? "新建" : "更新"} ${e.path}`);
    } else if (e.type === "delete") {
      steps.push({ type: "banner", text: `删除 ${e.path}`, delay: 380 });
      logs.push(e.ok ? `删除 ${e.path}` : `删除失败：${e.error}`);
    } else if (e.type === "move") {
      steps.push({ type: "banner", text: `移动 ${e.from} → ${e.to}`, delay: 380 });
      logs.push(e.ok ? `移动 ${e.from} → ${e.to}` : `移动失败：${e.error}`);
    } else if (e.type === "run") {
      steps.push({ type: "run", cmd: e.cmd || "", banner: "运行命令" });
      const out = (e.output || "").trim();
      logs.push(
        `$ ${e.cmd}\n${out ? out.slice(-900) : `（退出码 ${e.exit ?? 0}）`}`
      );
    } else if (e.type === "finish") {
      steps.push({ type: "done", text: e.text || "完成" });
    }
  }

  return { steps, logs };
}

function langOf(path: string) {
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".html")) return "xml";
  return "javascript";
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
  const [ws, setWs] = useState<Ws | null>(null);
  const [openPath, setOpenPath] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("stepcoding.recent") || "[]");
    } catch {
      return [];
    }
  });
  const [picking, setPicking] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
  const dirsLoaded = useRef<Set<string>>(new Set());
  const [tabs, setTabs] = useState<{ path: string; preview: boolean }[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});

  const codeRef = useRef<HTMLDivElement | null>(null);
  const taskRef = useRef("");
  const msgsRef = useRef<unknown[]>([]);
  const roundRef = useRef(0);
  const doneRef = useRef(false);
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
      if (doneRef.current) return;
      void nextRound();
    };
    void restoreWorkspace();

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

  // 工作区记在浏览器里：没开过就是空的，开过刷新才恢复
  async function restoreWorkspace() {
    const empty: Ws = { root: null, files: [], total: 0, truncated: false };
    let saved = localStorage.getItem(WS_KEY);
    const wantFile = new URLSearchParams(window.location.search).get("file");
    // 支持 ?ws=/path 直接打开一个项目（方便分享与截图）
    const wantWs = new URLSearchParams(window.location.search).get("ws");
    if (wantWs) {
      localStorage.setItem(WS_KEY, wantWs);
      saved = wantWs;
    }

    if (!saved) {
      // 把服务端可能残留的状态也清掉
      await fetch("/api/workspace/close", { method: "POST" }).catch(() => {});
      setWs(empty);
      return;
    }

    try {
      const res = await fetch("/api/workspace/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: saved }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error();
      setWs(data);
      if (wantFile) void openFile(wantFile, true);
    } catch {
      localStorage.removeItem(WS_KEY);
      setWs(empty);
    }
  }

  async function refreshTree() {
    dirsLoaded.current = new Set();
    setDirs({});
    await loadDir("");
    for (const dir of expanded) {
      dirsLoaded.current.delete(dir);
      await loadDir(dir);
    }
  }

  async function nextRound() {
    const p = playerRef.current!;
    setThinking(true);
    try {
      const res = await postJson("/api/agent/step", {
        messages: msgsRef.current,
        round: roundRef.current,
      });
      msgsRef.current = res.messages;
      roundRef.current += 1;

      if (res.say) setMessages((m) => [...m, { role: "agent", text: res.say }]);

      const { steps, logs } = eventsToSteps(res.events as AgentEvent[]);
      if (logs.length) {
        setMessages((m) => [...m, ...logs.map((text) => ({ role: "agent" as const, text }))]);
      }
      if (res.done) doneRef.current = true;

      void refreshTree();

      if (steps.length === 0) {
        makeSteplessProgress(res.done);
        return;
      }
      p.push(steps);
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/, "");
      setError(text);
      setMessages((m) => [...m, { role: "agent", text: `出错了：${text}` }]);
      doneRef.current = true;
      setBusy(false);
      playerRef.current!.push([{ type: "done", text: "中断" }]);
    } finally {
      setThinking(false);
    }
  }

  /** 一轮里没有任何可见动作（比如只调了 finish），直接推进或收尾。 */
  function makeSteplessProgress(done: boolean) {
    if (done) {
      setBusy(false);
      playerRef.current!.push([{ type: "done", text: "完成" }]);
      return;
    }
    window.setTimeout(() => void nextRound(), 0);
  }

  async function start(task: string) {
    const p = playerRef.current!;
    setMessages((m) => [...m, { role: "user", text: task }]);
    setBusy(true);
    setError(null);
    setPaths([]);
    taskRef.current = task;
    setShowPreview(false);
    setActiveTab(null);
    p.resetForTask();
    doneRef.current = false;
    roundRef.current = 0;

    setThinking(true);
    try {
      const intent = await postJson("/api/intent", { task });
      if (intent.intent === "chat") {
        setMessages((m) => [...m, { role: "agent", text: intent.reply }]);
        setBusy(false);
        return;
      }

      const sess = await postJson("/api/session", { task });
      msgsRef.current = sess.messages;
      setThinking(false);
      await nextRound();
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/, "");
      setError(text);
      setMessages((m) => [...m, { role: "agent", text: `出错了：${text}` }]);
      setBusy(false);
      doneRef.current = true;
      p.push([{ type: "done", text: "中断" }]);
    } finally {
      setThinking(false);
    }
  }

  async function loadDir(path: string) {
    if (dirsLoaded.current.has(path)) return;
    dirsLoaded.current.add(path);
    try {
      const res = await fetch(`/api/workspace/list?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "读不了目录");
      setDirs((prev) => ({ ...prev, [path]: data.entries }));
    } catch (e) {
      dirsLoaded.current.delete(path);
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  }

  // 换项目就清空缓存，只拉第一层
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    dirsLoaded.current = new Set();
    if (ws?.root) void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.root]);

  const toggleDir = (path: string) => {
    const willOpen = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (willOpen) void loadDir(path);
  };

  const working = thinking || snap.typing || (snap.total > 0 && !snap.finished);
  const [statusOn, setStatusOn] = useState(false);

  useEffect(() => {
    if (working) {
      setStatusOn(true);
      return;
    }
    const timer = window.setTimeout(() => setStatusOn(false), 4000);
    return () => window.clearTimeout(timer);
  }, [working]);

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

  const openWorkspace = async (path: string) => {
    if (!path.trim()) return;
    setWsError(null);
    try {
      const res = await fetch("/api/workspace/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "打不开");
      setWs(data);
      setOpenPath("");
      localStorage.setItem(WS_KEY, data.root);
      setRecent((prev) => {
        const next = [data.root, ...prev.filter((p) => p !== data.root)].slice(0, 4);
        localStorage.setItem("stepcoding.recent", JSON.stringify(next));
        return next;
      });
    } catch (e) {
      setWsError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const removeRecent = (path: string) => {
    setRecent((prev) => {
      const next = prev.filter((p) => p !== path);
      localStorage.setItem("stepcoding.recent", JSON.stringify(next));
      return next;
    });
  };

  const pickWorkspace = async () => {
    setWsError(null);
    setPicking(true);
    try {
      const res = await fetch("/api/workspace/pick", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "打不开选择框");
      if (data.path) await openWorkspace(data.path);
    } catch (e) {
      setWsError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setPicking(false);
    }
  };

  const closeWorkspace = async () => {
    localStorage.removeItem(WS_KEY);
    const res = await fetch("/api/workspace/close", { method: "POST" });
    setWs(await res.json());
    setTabs([]);
    setActiveTab(null);
    setContents({});
  };

  /** 单击 = 预览（会被下一次单击覆盖），双击 = 固定成标签页。 */
  const openFile = async (path: string, preview: boolean) => {
    setTabs((prev) => {
      const exists = prev.find((t) => t.path === path);
      if (exists) {
        if (!preview && exists.preview) {
          return prev.map((t) => (t.path === path ? { ...t, preview: false } : t));
        }
        return prev;
      }
      if (preview) {
        const i = prev.findIndex((t) => t.preview);
        if (i >= 0) {
          const next = [...prev];
          next[i] = { path, preview: true };
          return next;
        }
      }
      return [...prev, { path, preview }];
    });
    setActiveTab(path);

    if (path in contents) return;
    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "读不了");
      setContents((prev) => ({ ...prev, [path]: data.content }));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const pinTab = (path: string) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, preview: false } : t)));
    setActiveTab(path);
  };

  const closeTab = (path: string) => {
    const i = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    if (activeTab === path) {
      const fallback = next[Math.max(0, i - 1)] ?? next[0];
      setActiveTab(fallback ? fallback.path : null);
    }
  };

  const activeHtml = useMemo(() => {
    if (!activeTab) return "";
    const body = contents[activeTab];
    if (body === undefined) return "";
    try {
      return hljs.highlight(body, { language: langOf(activeTab) }).value;
    } catch {
      return body;
    }
  }, [activeTab, contents]);

  const toggle = () => {
    const p = playerRef.current!;
    p.paused = !p.paused;
    setPaused(p.paused);
  };

  const onSpeed = (value: number) => {
    setCps(value);
    playerRef.current!.cps = value;
  };


  if (!ws?.root) {
    return (
      <div className="welcome">
        <div className="welcome-inner">
          <div className="welcome-mark" />
          <h1>Step Coding</h1>
          <p>选一个文件夹，它会在里面写代码。每一步你都看得见。</p>

          <button className="welcome-open" onClick={() => void pickWorkspace()} disabled={picking}>
            {picking ? "等待选择…" : "打开项目文件夹"}
          </button>

          {recent.length > 0 && (
            <div className="welcome-recent">
              <div className="wr-title">最近打开</div>
              <div className="wr-list">
              {recent.map((path) => (
                <div key={path} className="wr-item" onClick={() => void openWorkspace(path)}>
                  <span className="wr-name">{path.split("/").filter(Boolean).pop()}</span>
                  <span className="wr-path">{path.replace(/^\/Users\/[^/]+/, "~")}</span>
                  <button
                    className="wr-x"
                    title="从列表移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecent(path);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              </div>
            </div>
          )}

          {wsError && <div className="welcome-error">{wsError}</div>}
        </div>
      </div>
    );
  }

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

      <main className="body">
        <aside className="tree">
          <div className="tree-title">
            <span className="tt-name">{ws.name || "项目"}</span>
            <button className="tree-close" title="关闭项目" onClick={() => void closeWorkspace()}>
              ×
            </button>
          </div>

          <div className="tree-scroll">
            {(() => {
              const rows: JSX.Element[] = [];
              const walk = (dirPath: string, depth: number) => {
                for (const node of dirs[dirPath] ?? []) {
                  const open = expanded.has(node.path);
                  rows.push(
                    <div
                      key={node.path}
                      className={`file ws ${node.type} ${node.type === "dir" ? "dir" : ""} ${
                        activeTab === node.path ? "active" : ""
                      } ${open ? "open" : ""}`}
                      style={{ paddingLeft: 6 + depth * 12 }}
                      onClick={() => {
                        if (node.type === "dir") toggleDir(node.path);
                        else void openFile(node.path, true);
                      }}
                      onDoubleClick={() => {
                        if (node.type === "file") pinTab(node.path);
                      }}
                    >
                      {node.type === "dir" && <span className="twist">›</span>}
                      <span className="fname">{node.name}</span>
                    </div>
                  );
                  if (node.type === "dir" && open) walk(node.path, depth + 1);
                }
              };
              walk("", 0);
              return rows;
            })()}
          </div>
        </aside>

        <section className="editor">
          <div className="tabs">
            {tabs.length > 0
              ? tabs.map((t) => (
                  <div
                    key={t.path}
                    className={`tab ${activeTab === t.path ? "active" : ""} ${
                      t.preview ? "preview" : ""
                    }`}
                    title={t.path}
                    onClick={() => setActiveTab(t.path)}
                    onDoubleClick={() => pinTab(t.path)}
                  >
                    <span className="tab-name">{t.path.split("/").pop()}</span>
                    <button
                      className="tab-x"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.path);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              : paths.map((path) => (
                  <div key={path} className={`tab ${active === path ? "active" : ""}`}>
                    {path}
                  </div>
                ))}
          </div>
          <div className="code" ref={codeRef}>
            {activeTab ? (
              <div className="code-inner" key={`v-${activeTab}`}>
                {contents[activeTab] === undefined ? (
                  <div className="placeholder">加载中…</div>
                ) : (
                  <pre dangerouslySetInnerHTML={{ __html: activeHtml }} />
                )}
              </div>
            ) : text ? (
              <div className="code-inner" key={`l-${active}`}>
                <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
                <span className={`caret ${paused || snap.finished ? "idle" : ""}`} />
              </div>
            ) : (
              <div className="placeholder">从左边选一个文件</div>
            )}
          </div>

          <div className={`status-toast ${statusOn ? "in" : ""}`}>
            <span className="st-dot" />
            <span className="st-text">{thinking ? "思考中…" : snap.banner}</span>
            {snap.total > 0 && (
              <span className="st-count">
                {snap.stepIndex}/{snap.total}
              </span>
            )}
          </div>
        </section>

        <aside className="chat">
          <div className="chat-head">对话</div>
          <div className="chat-log">
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
              if (!value || busy || !ws?.root) return;
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
