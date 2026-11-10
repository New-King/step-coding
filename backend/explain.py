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
from typing import Any

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


SYSTEM = """你是一个很会讲代码的老师。用户想弄懂一件事——可能是一个概念、
一个环节，也可能是"帮我写个页面看看长什么样"。你用最小的例子讲给他看。

只输出一个 JSON 对象，不要任何解释：

{
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
8. 语言跟随用户问题里提到的技术栈；没提就按最合适的来（界面用 html/css/js）。"""


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
