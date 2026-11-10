"""Agent：真的 function calling，不是文本协议。

每一轮：把消息 + 工具清单发给模型 → 模型返回 tool_calls → 我们执行 → 回填结果。
循环到模型调用 finish 或者到步数上限。

这样加一个工具只需要在 tools.py 里写一次 schema，prompt、解析、执行都不用再各写一遍。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import tools as toolbox
from .workspace import workspace as ws

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

MAX_ROUNDS = 12


class AgentError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(API_KEY)


SYSTEM = """你是一个写代码的助手。用户给你一个任务，你在当前项目里把它做出来。

工作方式（像人一样，一步一步来）：
1. 先看现场：用 list_dir 看目录，用 read_file 读关键文件。不要凭空假设项目里有什么。
2. 再动手：一次写一个文件，用 write_file，内容必须是完整的、能直接运行的。
3. 写完验证：用 run_command 跑构建/测试/启动，看输出。
4. 报错就修：读报错 → 改文件 → 再跑。直到通过。
5. 完成后调用 finish，附一句总结。

规矩：
- 只在项目目录内操作，不要碰外面的路径。
- 不要写 TODO、省略号、"此处省略"，每个文件都要完整。
- write_file 的 sections 是可选的：把文件切成语义小段（每段 5～25 行）并各配一句
  不超过 12 字的说明，用户就能看清你在写什么。给了 sections 的话，按顺序拼起来
  必须正好等于 content。
- 用户能实时看到你的每一步，所以说明要短、要具体（"随机放置食物"而不是"写逻辑"）。"""


def _chat(messages: list[dict[str, Any]], tools: list[dict] | None = None) -> dict:
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    body: dict[str, Any] = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 8000,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise AgentError(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AgentError(f"网络错误: {exc}") from exc

    choice = data["choices"][0]
    msg = choice.get("message") or {}
    if not msg.get("content") and not msg.get("tool_calls"):
        usage = data.get("usage", {})
        reason = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
        raise AgentError(f"模型没有输出（finish={choice.get('finish_reason')}，推理 {reason} tokens）")
    return msg


def _event(name: str, args: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """把一次工具调用翻译成前端能播的事件。"""
    ok = result.get("ok", True) and not result.get("error")

    if name == "write_file":
        sections = args.get("sections") or []
        if not sections:
            body = result.get("content", args.get("content", ""))
            sections = [{"note": f"写入 {args.get('path', '')}", "code": body}]
        return {
            "type": "write",
            "path": args.get("path", ""),
            "sections": sections,
            "created": result.get("created", False),
            "ok": ok,
        }
    if name == "mkdir":
        return {"type": "mkdir", "path": args.get("path", ""), "ok": ok, "error": result.get("error")}
    if name == "delete":
        return {"type": "delete", "path": args.get("path", ""), "ok": ok, "error": result.get("error")}
    if name == "move":
        return {
            "type": "move",
            "from": args.get("from", ""),
            "to": args.get("to", ""),
            "ok": ok,
            "error": result.get("error"),
        }
    if name == "run_command":
        return {
            "type": "run",
            "cmd": args.get("command", ""),
            "output": (result.get("stdout") or "") + (result.get("stderr") or ""),
            "exit": result.get("exit", 0),
            "ok": ok,
            "error": result.get("error"),
        }
    if name == "finish":
        return {"type": "finish", "text": args.get("summary", "")}
    if name in ("read_file", "list_dir"):
        return {"type": "look", "tool": name, "target": args.get("path", "") or "."}
    return {"type": "note", "text": name}


def start(task: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"任务：{task}"},
    ]


def step(messages: list[dict[str, Any]], round_no: int = 0) -> dict[str, Any]:
    """跑一轮。返回新的消息、要播的事件、是否结束。"""
    if round_no >= MAX_ROUNDS:
        return {"messages": messages, "events": [{"type": "finish", "text": "步数到上限，先停在这里。"}], "done": True, "say": ""}

    msg = _chat(messages, tools=toolbox.TOOLS)
    calls = msg.get("tool_calls") or []

    messages.append(
        {
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": calls,
        }
    )

    events: list[dict[str, Any]] = []
    done = False

    for call in calls:
        name = call["function"]["name"]
        try:
            args = json.loads(call["function"].get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}

        result = toolbox.execute(name, args, ws)
        events.append(_event(name, args, result))

        messages.append(
            {
                "role": "tool",
                "tool_call_id": call["id"],
                "content": json.dumps(result, ensure_ascii=False)[:6000],
            }
        )

        if name == "finish":
            done = True

    return {
        "messages": messages,
        "events": events,
        "done": done,
        "say": (msg.get("content") or "").strip(),
    }


DECIDE_SYSTEM = """判断用户这句话是在让你写代码/改项目，还是在打招呼、闲聊、提问。

严格输出两行：
INTENT: chat 或 build
REPLY: 一句自然的中文回复，30 字以内（build 时留空）

规则：
- 明确要做某个东西、改某个文件 → build
- 打招呼、寒暄、问你是谁 → chat
- 只给模糊方向（"做个网页"）→ build"""


def decide(task: str) -> dict[str, Any]:
    msg = _chat(
        [
            {"role": "system", "content": DECIDE_SYSTEM},
            {"role": "user", "content": task},
        ]
    )
    text = msg.get("content") or ""
    intent = "build"
    reply = ""
    for line in text.splitlines():
        line = line.strip()
        if line.upper().startswith("INTENT:") and "chat" in line.lower():
            intent = "chat"
        elif line.upper().startswith("REPLY:"):
            reply = line.split(":", 1)[1].strip().strip('"')
    if intent == "chat" and not reply:
        reply = "你好，想让我做什么？"
    return {"intent": intent, "reply": reply}
