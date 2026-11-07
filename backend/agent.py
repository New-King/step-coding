"""真 agent：先定文件清单，再逐个把文件写出来。

为什么分两步：
  - 让模型自己决定"下一个写哪个文件"，它会往一个文件里塞所有东西，
    写完还会不停"优化"，永远不结束。
  - 先让它列出文件清单，之后每次只负责"把指定的这个文件写完整"，
    结构就定了，而且一定收敛。
"""

from __future__ import annotations

import json
import os
import re
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
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")

MAX_TOKENS = 8000
MAX_FILES = 6


def has_key() -> bool:
    return bool(API_KEY)


class AgentError(RuntimeError):
    pass


# ---------------------------------------------------------------- 调用

def _chat(messages: list[dict[str, str]], max_tokens: int = MAX_TOKENS) -> str:
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
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
        raise AgentError(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AgentError(f"网络错误: {exc}") from exc

    choice = data["choices"][0]
    text = (choice.get("message", {}).get("content") or "").strip()
    if not text:
        usage = data.get("usage", {})
        reason = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
        raise AgentError(f"模型没有输出内容（finish={choice.get('finish_reason')}，推理 {reason} tokens）")
    return text


# ---------------------------------------------------------------- 第一步：定文件

PLAN_SYSTEM = """你是一个写代码的助手。用户会给你一个任务，你只需要决定要写哪几个文件。

只输出文件名，每行一个，按创建顺序排列。不要解释，不要编号，不要代码块。
路径用相对路径，最多 5 个文件。比如：

index.html
style.css
game.js"""


def plan_files(task: str) -> list[str]:
    text = _chat(
        [
            {"role": "system", "content": PLAN_SYSTEM},
            {"role": "user", "content": f"任务：{task}"},
        ],
        max_tokens=200,
    )

    files: list[str] = []
    for line in text.splitlines():
        name = re.sub(r"^[\s\-*\d.、)）]+", "", line).strip().strip("`'\"")
        if not name or " " in name or len(name) > 40:
            continue
        if not re.match(r"^[\w\-./]+\.[A-Za-z0-9]{1,6}$", name):
            continue
        if name not in files:
            files.append(name)
        if len(files) >= MAX_FILES:
            break

    if not files:
        raise AgentError(f"没能解析出文件清单：{text[:80]}")
    return files


# ---------------------------------------------------------------- 第二步：写一个文件

WRITE_SYSTEM = """你是一个写代码的助手。用户会告诉你项目要做什么、已经有了哪些文件，
以及这次要写的**一个**文件。你只写这个文件。

严格按下面的纯文本格式回答，不要用 JSON，不要加代码块围栏，不要额外解释：

SAY: 这个文件在做什么，20 字以内
SECTION: 这一小段在写什么，12 字以内
<<<
这一段的代码
>>>

SECTION: 下一段在写什么
<<<
这一段的代码
>>>

规则：
1. 只输出这一个文件的内容，不要写别的文件。
2. 代码切成有意义的小段，一段大约 5～25 行：
   比如 页面结构 / 样式重置 / 画布绘制 / 撞墙判定 / 吃到食物加分 / 死亡处理。
   不要整份文件只给一段。
3. 所有 SECTION 的代码按顺序拼起来必须正好是完整文件，能直接运行；
   不允许 TODO、省略号、"此处省略"。
4. 代码原样写，不需要转义：双引号、反斜杠、模板字符串直接写。
   唯一例外：代码里不要出现单独一行的 >>>。
5. 如果这个文件要引用别的文件（比如 html 里 link css），按文件清单里的路径写。"""


def _project_context(task: str, files: dict[str, str], plan: list[str]) -> str:
    parts = [f"任务：{task}", ""]
    parts.append("这次要写的文件：" + files.get("__current__", ""))
    parts.append("")
    parts.append("整个项目的文件清单：")
    for path in plan:
        parts.append(f"- {path}")
    parts.append("")

    existing = {k: v for k, v in files.items() if not k.startswith("__")}
    if existing:
        parts.append("已经写好的文件（供你参考它们的接口和类名）：")
        for path, content in existing.items():
            parts.append(f"--- {path} ---")
            parts.append(content[:4000])
        parts.append("")
    else:
        parts.append("这是第一个文件。")
        parts.append("")
    return "\n".join(parts)


HEADER_RE = re.compile(r"^(SAY|TYPE|PATH|CMD)\s*[:：]\s*(.*)$", re.M)
SECTION_RE = re.compile(r"SECTION\s*[:：]\s*(.*?)\s*\n<<<\n(.*?)\n>>>", re.S)


def parse_reply(raw: str) -> dict[str, Any]:
    text = raw.replace("\r\n", "\n")
    header: dict[str, str] = {}
    for key, value in HEADER_RE.findall(text):
        header.setdefault(key, value.strip())

    sections = [
        {"note": (note.strip() or "写代码")[:24], "code": code if code.endswith("\n") else code + "\n"}
        for note, code in SECTION_RE.findall(text)
    ]

    return {"say": header.get("SAY", "").strip(), "sections": sections}


def write_file(task: str, path: str, files: dict[str, str], plan: list[str]) -> dict[str, Any]:
    context = _project_context(task, {**files, "__current__": path}, plan)
    raw = _chat(
        [
            {"role": "system", "content": WRITE_SYSTEM},
            {"role": "user", "content": context},
        ]
    )

    parsed = parse_reply(raw)
    sections = parsed["sections"]
    if not sections:
        raise AgentError(f"《{path}》没有解析出任何 SECTION")

    content = "".join(part["code"] for part in sections)
    if not content.endswith("\n"):
        content += "\n"

    return {
        "path": path,
        "say": parsed["say"] or f"写 {path}",
        "sections": sections,
        "content": content,
    }
