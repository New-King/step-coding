"""一次只做一个动作的 agent 循环。

和之前的区别：以前一轮交回一整批 ops，中间没有过程、没法插手。
现在每轮只做一个动作，动作全部可见：

  think  说出正在确认什么、打算怎么做
  look   读一下当前项目里到底有什么（新项目也要先看）
  plan   列出这一轮要做哪几步
  ask    卡住了就问，带选项
  write  新建一个文件
  edit   改一个文件的一段
  delete 删一个文件
  finish 收工

由前端驱动：每拿到一个动作、播完、再问下一个。所以中途随时能停。
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import search
from .fs import apply as apply_fs
from .prompt import SYSTEM
from .actions import normalize
from .agent_error import AgentError
from .context import content as read_content
from .context import content as read_content
from .guards import GENTLE, FIRM, REPEAT_THRESHOLDS, claims_missing, repeat_streak
from .tools import TOOL_NAME_TO_ACTION, TOOLS, loads

ROOT = Path(__file__).resolve().parent.parent

API_KEY = ""
BASE_URL = "https://api.deepseek.com/v1"
MODEL = "deepseek-chat"
MAX_ROUNDS = 24


def _load_env() -> None:
    global API_KEY, BASE_URL, MODEL
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
    BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")


_load_env()


def has_key() -> bool:
    return bool(API_KEY)





def _call(messages: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    """真的 function calling：返回 (动作, 助手消息, tool_call)。"""
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    payload = {
        "model": MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
        "max_tokens": 6000,
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:200]
        raise AgentError(f"模型返回 HTTP {exc.code} {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AgentError(f"连不上模型：{exc}") from exc

    msg = (data["choices"][0].get("message") or {})
    calls = msg.get("tool_calls") or []

    if not calls:
        text = (msg.get("content") or "").strip()
        action = {"action": "say", "text": text[:200] or "……"}
        return action, {"role": "assistant", "content": text}, None

    call = calls[0]
    name = call.get("function", {}).get("name", "")
    args = loads(call.get("function", {}).get("arguments") or "{}")

    if "content" in args and "code" not in args:
        args["code"] = args.pop("content")

    action = normalize({"action": TOOL_NAME_TO_ACTION.get(name, ""), **args})
    assistant = {
        "role": "assistant",
        "content": msg.get("content") or "",
        "tool_calls": [call],
    }
    return action, assistant, call


def _record(
    messages: list[dict[str, Any]],
    assistant: dict[str, Any],
    call: dict[str, Any] | None,
    result: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """把"模型说了什么"和"工具返回了什么"都记进历史。"""
    out = messages + [assistant]
    if call is not None:
        out = out + [
            {
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "content": json.dumps(result or {"ok": True}, ensure_ascii=False)[:4000],
            }
        ]
    return out


def step(
    messages: list[dict[str, Any]],
    files: dict[str, str],
    round_no: int,
    pending_search: str = "",
    observed: set[str] | None = None,
) -> dict[str, Any]:
    """跑一轮，返回下一个动作。"""
    if pending_search:
        try:
            results = search.dedupe(search.query(pending_search))
            detail = search.render(results)
        except search.SearchError as exc:
            results = []
            detail = f"搜索失败：{exc}"
        return {
            "event": {"action": "search", "query": pending_search, "results": results},
            "messages": messages + [{"role": "user", "content": f"搜索结果：\n{detail}"}],
        }

    if round_no >= MAX_ROUNDS:
        return {"event": {"action": "finish", "text": "步数到上限，先停在这里"}, "messages": messages}

    ability = (
        "当前有联网搜索能力，可以用 search 查资料。"
        if search.enabled()
        else "当前没有配置联网搜索，不要使用 search 工具。"
    )
    # system 里只放固定内容，不放文件清单：
    # 只要这一串不变，模型的上下文缓存就能一直命中
    system = {"role": "system", "content": f"{SYSTEM}\n\n{ability}"}

    # 重复调用：按 3 / 5 / 8 分级处理，先提醒，实在停不下来才收尾
    streak = repeat_streak(messages)
    if streak >= REPEAT_THRESHOLDS[2]:
        return {
            "event": {"action": "finish", "text": "同一个动作重复太多次了，先停在这里。"},
            "messages": messages,
        }
    if streak == REPEAT_THRESHOLDS[0]:
        messages = messages + [{"role": "user", "content": GENTLE}]
    elif streak == REPEAT_THRESHOLDS[1]:
        messages = messages + [{"role": "user", "content": FIRM}]

    action, assistant, call = _call([system, *messages])

    if action["action"] == "ask":
        return {"event": action, "messages": _record(messages, assistant, call), "stop": True}

    if action["action"] in {"say", "finish"}:
        missing = claims_missing(action.get("text", ""), files)
        if missing:
            demand = (
                f"你在回复里提到 {', '.join(missing)}，但项目里没有这个文件。"
                "不要只说，直接调用 write_file 把它写出来。"
            )
            retry_messages = _record(messages, assistant, call, {"ok": False, "error": demand})
            retry_action, retry_assistant, retry_call = _call(
                [system, *retry_messages, {"role": "user", "content": demand}]
            )
            if retry_action["action"] in {"write", "edit", "delete"}:
                state, problem = apply_fs(retry_action, files)
                if not problem:
                    done = {"ok": True, "files": list(state)}
                    return {
                        "event": retry_action,
                        "messages": _record(retry_messages, retry_assistant, retry_call, done),
                        "files": state,
                    }
            return {
                "event": {
                    "action": "say",
                    "text": f"我还没真的写出 {', '.join(missing)}，刚才那句不算。再说一次我就动手。",
                },
                "messages": retry_messages,
                "stop": True,
            }

        return {"event": action, "messages": _record(messages, assistant, call), "stop": True}

    if action["action"] == "decline":
        return {"event": action, "messages": _record(messages, assistant, call), "stop": True}

    if action["action"] == "search":
        return {
            "event": action,
            "messages": _record(messages, assistant, call, {"ok": True, "pending": True}),
            "pending_search": action["query"],
        }

    if action["action"] == "look":
        path = action.get("path") or ""
        if observed is not None:
            if path:
                observed.add(path)
            else:
                observed.update(files)
        if path and files.get(path):
            body = files[path]
            detail = f"=== {path}（{len(body.splitlines())} 行）===\n{body}"
        else:
            detail = "当前项目：\n" + "\n".join(f"  {p}" for p in files) if files else "项目是空的。"
        return {
            "event": action,
            "messages": _record(messages, assistant, call, {"ok": True, "content": detail[:6000]}),
        }

    if action["action"] in {"write", "edit", "delete"}:
        state, problem = apply_fs(action, files, observed)
        if problem:
            return {
                "event": {"action": "error", "text": problem},
                "messages": _record(messages, assistant, call, {"ok": False, "error": problem}),
                "files": files,
            }

        if action["action"] == "write":
            body = state.get(action["path"], "")
            done = f"已写入 {action['path']}（{len(body.splitlines())} 行）。"
        elif action["action"] == "edit":
            done = f"已修改 {action['path']}。"
        else:
            done = f"已删除 {action['path']}。"

        result = {
            "ok": True,
            "message": f"{done}当前文件：{', '.join(state) or '无'}。做完就 finish，不要重复同一个动作。",
            "files": list(state),
        }
        return {"event": action, "messages": _record(messages, assistant, call, result), "files": state}

    # think / plan 不结束这一轮，继续往下走
    return {
        "event": action,
        "messages": _record(messages, assistant, call),
        "stop": action["action"] not in {"think", "plan"},
    }
