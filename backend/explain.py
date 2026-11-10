"""把一个"我不懂的环节"讲成一堂最小课。

一次调用产出一份结构化教案：
  节点（这个环节里有哪几个角色）
  步骤（按顺序写出来的代码，每步指向一个节点）
  代码（所有步骤拼起来 = 一份完整的最小示例）

刻意不做的事：不跑代码、不接本地文件、不写完整项目。
"最小"是硬约束，靠生成后的检查强制，不靠 prompt 祈求。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


_load_env()

API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

MAX_NODES = 4
MAX_FILES = 4
MAX_STEPS = 12
MAX_LINES = 160


class ExplainError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(API_KEY)


SYSTEM = """你是一个很会讲代码的人。用户想弄懂一件事——可能是一个概念、
一个环节，也可能是"帮我写个页面看看长什么样"。你用最小的例子写给他看。

只输出一个 JSON 对象，不要任何解释。

如果用户只是在打招呼、问你能做什么、或者还没想清楚要什么，
不要写代码，只回一句话：

{"action": "reply", "text": "一句话，自然点"}

真要写的时候：

{
  "action": "build",
  "title": "这件事叫什么，14 字以内",
  "summary": "一句话说清，40 字以内",
  "kind": "concept | flow | ui",
  "files": [
    {"path": "app.js", "lang": "javascript"}
  ],
  "flow": [
    {"label": "角色名，6 字以内", "desc": "它在干什么，20 字以内"}
  ],
  "steps": [
    {"label": "这一步在写什么，14 字以内", "file": "app.js", "focus": 0, "code": "这段代码，换行结尾"}
  ]
}

硬性要求：
1. files 1～4 个。小界面通常 index.html + style.css + app.js；
   讲概念常常只要一个文件。
2. steps 3～12 个。同一个文件的多段代码按顺序拼起来，就是完整文件。
3. **总代码不超过 160 行**（讲概念时更少，控制在 60 行内更好）。
   宁可少讲一个细节，也不要写长。
4. 只留主干：不要 import、不要 package.json、不要构建配置、不要错误处理样板、
   不要大段注释。用户要的是看懂，不是能上线。
5. 但语法必须是真实语言的，能直接看懂、能抄走。不要写伪代码。
6. flow 是可选的：
   - 如果这件事是"几个部分怎么配合"（中间件链、请求生命周期、数据流），
     就给 2～4 个节点，并在 steps 里用 focus 指向当前节点。
   - 如果只是"写一个页面长什么样"，flow 给空数组 []。
7. kind 说明：concept=讲概念，flow=讲流程/环节，ui=写界面。
8. 语言跟随用户问题里提到的技术栈；没提就按最合适的来（界面用 html/css/js）。

什么时候 reply 而不是 build：
- 打招呼、寒暄、问你是谁 / 能干什么
- 用户在追问上一段内容是什么意思（能直接用话讲清就别重写代码）
- 说的太模糊，你需要先问一句
- 已经有内容时，用户问的是"这里为什么这样"这类问题

reply 的语气：像同事说话，短。不要"您好！我是您的编程助手，很高兴为您服务"，
也不要每句都先夸一下用户的问题。一次只问一个问题，别连环追问。"""


def _chat(messages: list[dict[str, str]]) -> str:
    if not API_KEY:
        raise ExplainError("未配置 DEEPSEEK_API_KEY")

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 4000,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ExplainError(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ExplainError(f"网络错误: {exc}") from exc

    content = (data["choices"][0].get("message") or {}).get("content") or ""
    if not content.strip():
        raise ExplainError("模型没有返回内容")
    return content


def _lines(text: str) -> int:
    return len([ln for ln in text.splitlines() if ln.strip()])


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    files = []
    for item in (raw.get("files") or [])[:MAX_FILES]:
        path = str(item.get("path") or "").strip().lstrip("/")
        if not path:
            continue
        files.append({"path": path, "lang": str(item.get("lang") or "javascript").lower()[:16]})
    if not files:
        raise ExplainError("没有生成出文件")

    paths = [f["path"] for f in files]

    steps = []
    for item in (raw.get("steps") or [])[:MAX_STEPS]:
        code = item.get("code") or ""
        if not isinstance(code, str) or not code.strip():
            continue
        if not code.endswith("\n"):
            code += "\n"
        target = str(item.get("file") or paths[0]).strip().lstrip("/")
        if target not in paths:
            target = paths[0]
        try:
            focus = int(item.get("focus", 0))
        except (TypeError, ValueError):
            focus = 0
        steps.append(
            {
                "label": str(item.get("label") or "继续").strip()[:24],
                "file": target,
                "focus": max(0, focus),
                "code": code,
            }
        )
    if not steps:
        raise ExplainError("没生成出可讲的步骤")

    flow = []
    for item in (raw.get("flow") or [])[:MAX_NODES]:
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        flow.append({"label": label[:12], "desc": str(item.get("desc") or "").strip()[:40]})
    if len(flow) < 2:
        flow = []

    for step in steps:
        step["focus"] = max(0, min(len(flow) - 1, step["focus"])) if flow else -1

    total = sum(_lines(s["code"]) for s in steps)
    return {
        "title": str(raw.get("title") or "这件事").strip()[:30],
        "summary": str(raw.get("summary") or "").strip()[:60],
        "kind": str(raw.get("kind") or "concept").strip()[:12],
        "files": files,
        "flow": flow,
        "steps": steps,
        "lines": total,
        "tooLong": total > MAX_LINES,
    }


def render_context(lesson: dict[str, Any]) -> str:
    """把当前内容压成一段给模型看的上下文。"""
    lines = [f"标题：{lesson.get('title')}", f"说明：{lesson.get('summary')}"]
    for f in lesson.get("files", []):
        lines.append(f"\n--- {f['path']} ---")
        code = "".join(s["code"] for s in lesson.get("steps", []) if s.get("file") == f["path"])
        lines.append(code.rstrip())
    return "\n".join(lines)


def converse(messages: list[dict[str, str]], current: Optional[dict[str, Any]]) -> dict[str, Any]:
    """一轮对话：要么只说话，要么给一份（新的/改过的）内容。"""
    msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
    if current:
        msgs.append(
            {
                "role": "system",
                "content": (
                    "现在屏幕上已经有这份内容，用户是在它的基础上说话。\n"
                    "如果他要改，就给一份完整的新版本（保留没问题的部分，把改的地方改掉）。\n\n"
                    + render_context(current)
                ),
            }
        )
    msgs.extend(messages)

    text = _chat(msgs)
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ExplainError("模型返回的不是合法 JSON，重试一次") from exc

    if str(raw.get("action", "build")) == "reply":
        said = str(raw.get("text") or "").strip()
        if not said:
            raise ExplainError("模型没说话")
        return {"action": "reply", "text": said[:200]}

    return {"action": "build", "lesson": _normalize(raw)}


def generate(question: str) -> dict[str, Any]:
    text = _chat(
        [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"我想弄懂：{question}\n\n用最小的例子讲给我看。"},
        ]
    )
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ExplainError("模型返回的不是合法 JSON，重试一次") from exc
    return _normalize(raw)
