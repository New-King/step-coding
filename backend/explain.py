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
MAX_STEPS = 6
MAX_LINES = 60


class ExplainError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(API_KEY)


SYSTEM = """你是一个很会讲代码的老师。用户说他不懂某个"环节"，你要用一个最小例子把它讲明白。

只输出一个 JSON 对象，不要任何解释：

{
  "title": "这个环节叫什么，12 字以内",
  "language": "javascript / python / go / ... （用真实语言，不要伪代码）",
  "summary": "一句话说清这个环节在干什么，40 字以内",
  "nodes": [
    {"label": "角色名，6 字以内", "desc": "它在干什么，20 字以内"}
  ],
  "steps": [
    {
      "label": "这一步在写什么，12 字以内",
      "focus": 0,
      "code": "这一段的代码，以换行结尾"
    }
  ]
}

硬性要求：
1. nodes 只放 2～4 个。它们是这个环节里真正互相作用的角色，
   比如 请求 / 鉴权中间件 / 处理函数，或者 状态 / 渲染 / 副作用。
   不要放"用户""浏览器"这种没信息量的东西。
2. steps 只放 3～6 个。所有 code 按顺序拼起来，就是完整例子。
3. **总代码不超过 60 行**。宁可少讲一个细节，也不要写长。
4. 只留主干：不要 import、不要 package.json、不要错误处理的样板、
   不要注释块、不要 console.log 调试行。用户要的是"关系"，不是能跑的工程。
5. 但语法必须是真实语言的，能直接看懂、能抄走。不要写伪代码。
6. focus 是这个步骤对应的 nodes 下标（从 0 开始）。
7. 语言跟随用户问题里提到的技术栈；没提就用 javascript。"""


def _chat(messages: list[dict[str, str]]) -> str:
    if not API_KEY:
        raise ExplainError("未配置 DEEPSEEK_API_KEY")

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 3000,
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
    nodes = []
    for item in (raw.get("nodes") or [])[:MAX_NODES]:
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        nodes.append({"label": label[:12], "desc": str(item.get("desc") or "").strip()[:40]})
    if len(nodes) < 2:
        raise ExplainError("这个环节拆不出至少两个角色，换个说法试试")

    steps = []
    for item in (raw.get("steps") or [])[:MAX_STEPS]:
        code = item.get("code") or ""
        if not isinstance(code, str) or not code.strip():
            continue
        if not code.endswith("\n"):
            code += "\n"
        try:
            focus = int(item.get("focus", 0))
        except (TypeError, ValueError):
            focus = 0
        steps.append(
            {
                "label": str(item.get("label") or "继续").strip()[:20],
                "focus": max(0, min(len(nodes) - 1, focus)),
                "code": code,
            }
        )
    if not steps:
        raise ExplainError("没生成出可讲的步骤")

    total = sum(_lines(s["code"]) for s in steps)
    return {
        "title": str(raw.get("title") or "这个环节").strip()[:30],
        "language": str(raw.get("language") or "javascript").strip().lower()[:20],
        "summary": str(raw.get("summary") or "").strip()[:60],
        "nodes": nodes,
        "steps": steps,
        "lines": total,
        "tooLong": total > MAX_LINES,
    }


def generate(question: str) -> dict[str, Any]:
    text = _chat(
        [
            {"role": "system", "content": SYSTEM},
            {
                "role": "user",
                "content": f"我不懂这个环节：{question}\n\n用最小例子讲给我看。",
            },
        ]
    )
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ExplainError("模型返回的不是合法 JSON，重试一次") from exc
    return _normalize(raw)
