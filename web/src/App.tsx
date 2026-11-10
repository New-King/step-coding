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

type Written = {
  path: string;
  say: string;
  sections: { note: string; code: string }[];
  content: string;
  written?: boolean;
};

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children: TreeNode[];
};

/** 扁平路径列表 → 目录树。默认全折叠，点目录才展开。 */
function buildTree(files: WsFile[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const f of files) {
    const node: TreeNode = { name: f.name, path: f.path, type: f.type, size: f.size, children: [] };
    byPath.set(f.path, node);

    const slash = f.path.lastIndexOf("/");
    const parent = slash > 0 ? byPath.get(f.path.slice(0, slash)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: TreeNode[]) => {
    list.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    );
    list.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

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
  const [viewFile, setViewFile] = useState<{ path: string; content: string } | null>(null);

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
      if (wantFile) void selectFile(wantFile);
    } catch {
      localStorage.removeItem(WS_KEY);
      setWs(empty);
    }
  }

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
      if (data.written) {
        fetch("/api/workspace")
          .then((r) => r.json())
          .then((next: Ws) => setWs(next))
          .catch(() => {});
      }
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
    setViewFile(null);
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

  const tree = useMemo(() => buildTree(ws?.files ?? []), [ws]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

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
    setViewFile(null);
  };

  const selectFile = async (path: string) => {
    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "读不了");
      setViewFile({ path, content: data.content });
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const viewHtml = useMemo(() => {
    if (!viewFile) return "";
    try {
      return hljs.highlight(viewFile.content, { language: langOf(viewFile.path) }).value;
    } catch {
      return viewFile.content;
    }
  }, [viewFile]);

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

      <div className={`banner ${snap.finished ? "done" : ""}`}>
        <span className={`pulse ${paused || thinking ? "paused" : ""}`} />
        <span className="banner-text" key={thinking ? "__thinking" : snap.banner}>
          {thinking ? "思考下一步…" : snap.banner}
        </span>
        <span className="banner-progress">
          <i style={{ width: `${progress}%` }} />
        </span>
      </div>

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
              const walk = (nodes: TreeNode[], depth: number) => {
                for (const node of nodes) {
                  const open = expanded.has(node.path);
                  rows.push(
                    <div
                      key={node.path}
                      className={`file ws ${node.type} ${node.type === "dir" ? "dir" : ""} ${
                        viewFile?.path === node.path ? "active" : ""
                      } ${open ? "open" : ""}`}
                      style={{ paddingLeft: 6 + depth * 12 }}
                      onClick={() => {
                        if (node.type === "dir") toggleDir(node.path);
                        else void selectFile(node.path);
                      }}
                    >
                      {node.type === "dir" && <span className="twist">›</span>}
                      <span className="fname">{node.name}</span>
                    </div>
                  );
                  if (node.type === "dir" && open) walk(node.children, depth + 1);
                }
              };
              walk(tree, 0);
              return rows;
            })()}
            {ws.truncated && <div className="tree-empty">文件太多，已截断</div>}
          </div>
        </aside>

        <section className="editor">
          <div className="tabs">
            {viewFile ? (
              <div className="tab active">{viewFile.path}</div>
            ) : (
              paths.map((path) => (
                <div key={path} className={`tab ${active === path ? "active" : ""}`}>
                  {path}
                </div>
              ))
            )}
          </div>
          <div className="code" ref={codeRef}>
            {viewFile ? (
              <div className="code-inner" key={`v-${viewFile.path}`}>
                <pre dangerouslySetInnerHTML={{ __html: viewHtml }} />
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
