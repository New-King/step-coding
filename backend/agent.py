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
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import search
from .actions import SAY_CHARS, SAY_TOO_LONG, normalize
from .agent_error import AgentError, TruncatedError
from .context import content as read_content
from .context import manifest
from .fs import apply as apply_fs
from .guards import (
    FIRM,
    GENTLE,
    REPEAT_THRESHOLDS,
    claims_changed,
    claims_missing,
    repeat_streak,
    touched_paths,
)
from .prompt import SYSTEM
from .tools import TOOL_NAME_TO_ACTION, TOOLS, loads

ROOT = Path(__file__).resolve().parent.parent

API_KEY = ""
BASE_URL = "https://api.deepseek.com/v1"
MODEL = "deepseek-flash"
MAX_ROUNDS = 20
LLM_TIMEOUT = 180
LLM_MAX_TOKENS = 6000
LLM_RETRIES = 1


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def _load_env() -> None:
    global API_KEY, BASE_URL, MODEL, LLM_TIMEOUT, LLM_MAX_TOKENS, LLM_RETRIES
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
    MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")
    LLM_TIMEOUT = _int_env("LLM_TIMEOUT", 180)
    LLM_MAX_TOKENS = _int_env("LLM_MAX_TOKENS", 6000)
    LLM_RETRIES = _int_env("LLM_RETRIES", 1)


_load_env()


def has_key() -> bool:
    return bool(API_KEY)





def _post(payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# 本轮用掉的 token：_call 里累加，step 开头清零，main 用 take_tokens() 取走记账
_TOKENS = 0


def take_tokens() -> int:
    """取走上一轮累计的 token（读后清零）。"""
    global _TOKENS
    used, _TOKENS = _TOKENS, 0
    return used


def _call(messages: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    """真的 function calling：返回 (动作, 助手消息, tool_call)。

    传输层失败（超时、429、5xx）自动重试一次；4xx 和截断不重试。
    """
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    payload = {
        "model": MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.2,
        "max_tokens": LLM_MAX_TOKENS,
    }

    # flash 默认先思考再回答（官方文档「思考模式」，默认开、effort=high）：
    # 每一步只是个小动作，思考只会让延迟翻倍、白烧 token，所以关掉。
    # chat 这类不支持该参数的模型不能带，否则报 400。
    if "flash" in MODEL:
        payload["thinking"] = {"type": "disabled"}

    data: dict[str, Any] | None = None
    last_error = ""
    for attempt in range(LLM_RETRIES + 1):
        try:
            data = _post(payload)
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:200]
            last_error = f"模型返回 HTTP {exc.code} {detail}"
            if exc.code not in {429, 500, 502, 503, 504} or attempt >= LLM_RETRIES:
                raise AgentError(last_error) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = f"模型超时或连不上（{LLM_TIMEOUT}s）：{exc}"
            if attempt >= LLM_RETRIES:
                raise AgentError(last_error) from exc
        time.sleep(0.8 * (attempt + 1))

    if data is None:
        raise AgentError(last_error or "模型没有返回内容")

    # 记账用：DeepSeek 返回 usage.total_tokens
    global _TOKENS
    try:
        _TOKENS += int(((data.get("usage") or {}).get("total_tokens")) or 0)
    except (TypeError, ValueError):
        pass

    choice = (data.get("choices") or [{}])[0]
    if choice.get("finish_reason") == "length":
        raise TruncatedError(
            f"模型输出被截断（max_tokens={LLM_MAX_TOKENS}），文件太大。"
            "把它拆成两个文件，或者调大 LLM_MAX_TOKENS 再试。"
        )

    msg = choice.get("message") or {}
    calls = msg.get("tool_calls") or []

    if not calls:
        text = (msg.get("content") or "").strip()
        # 模型没走 say 工具、直接把话写在 content 里：同一套上限，别在这一路砍短
        action = {"action": "say", "text": text[:SAY_CHARS] or "……"}
        return action, {"role": "assistant", "content": text}, None

    call = calls[0]
    name = call.get("function", {}).get("name", "")
    raw_args = call.get("function", {}).get("arguments") or "{}"
    args = loads(raw_args)
    if not args and raw_args.strip() not in {"", "{}"}:
        raise AgentError("工具参数不是合法 JSON，多半是输出被截断；拆小文件再试。")

    if "content" in args and "code" not in args:
        args["code"] = args.pop("content")

    # 动作类型只由工具名决定：参数里若也带一个 `action`（模型偶尔会塞），
    # 展开顺序必须让外层覆盖它，否则一次 write_file 能被参数改判成 say
    action = normalize({**args, "action": TOOL_NAME_TO_ACTION.get(name, "")})
    assistant = {
        "role": "assistant",
        "content": msg.get("content") or "",
        "tool_calls": [call],
    }
    return action, assistant, call


# 发给模型的历史条数上限（可用 HISTORY_KEEP 环境变量覆盖）
# 一个任务（建三个文件 + 改引用）要十几步，窗口太小会把开头丢掉
HISTORY_KEEP = int(os.environ.get("HISTORY_KEEP") or 40)
# 工具结果写进历史时**不压内容**，这个上限只是防止单条把上下文顶爆。
# 真触发了也必须让模型看见「被截断了」，不能让它以为手里就是全文。
RECORD_KEEP = 200000

# 历史**只按条数裁，不改内容**。
#
# 这里曾经把模型自己写过的 content / find / replace（>400 字符）换成
# 「（已写入 x 的 6120 字符，内容见项目文件，要改先 look）」，还把旧工具结果压到 1200 字符。
# 结果是模型看到的历史是假的：它照着占位符的口气写文件（app.js 真被写成了这句话），
# 拆文件时手里没有原文，只能凭印象整份重写——用户在界面上看到的就是「说了做不到」。
# 空间靠 `_recent` 的条数窗口控制；**不要**再往历史里插占位符。


USER_PIN = 8  # 被裁掉的那段里，最多补回几条用户指令


def _pair_tools(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """让每条 tool 消息都紧跟在它那条 assistant(tool_calls) 后面。

    接口的硬要求：tool 必须是某次 tool_calls 的回复，而且每个 tool_call_id 都要有回复。
    裁剪历史时窗口边界会把这一对切开，发出去就是
    `400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
    这里按组处理：回复没回完的调用整组丢掉，无主的回复也丢掉。
    """
    out: list[dict[str, Any]] = []
    pending: set[str] = set()
    start = -1  # 上一条 assistant(tool_calls) 在 out 里的下标
    for m in messages:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            if pending and start >= 0:
                del out[start:]  # 上一次调用没回完：整组作废
            pending = {str(c.get("id") or "") for c in m["tool_calls"]}
            start = len(out)
            out.append(m)
        elif role == "tool":
            cid = str(m.get("tool_call_id") or "")
            if cid and cid in pending:
                pending.discard(cid)
                out.append(m)
            # 无主（或重复）的回复：丢掉
        else:
            if pending and start >= 0:
                del out[start:]
                pending = set()
                start = -1
            out.append(m)
    if pending and start >= 0:
        del out[start:]
    return out


def _recent(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """只把最近 HISTORY_KEEP 条历史发给模型，否则一轮下来每条都重发全量。

    三条不省：
    - 用户说过的每句话都留着。一轮 20 步就有 40 多条历史，只取尾巴的话，
      上一轮「改一下标题颜色」这类指令会整条消失，模型只能靠 look 猜。
    - 最开头的需求排在第一位，顺序久了容易丢。
    - tool 消息必须跟它那条 assistant(tool_calls) 一起留，拆开接口会 400。
    """
    if len(messages) <= HISTORY_KEEP:
        return _pair_tools(list(messages))

    head = [messages[0]] if messages[0].get("role") == "user" else []
    rest = messages[len(head):]
    keep = max(1, HISTORY_KEEP - len(head))
    tail = rest[-keep:]
    pinned = [m for m in rest[:-keep] if m.get("role") == "user"][-USER_PIN:]
    # 补回的用户消息插在窗口前面，窗口第一条可能正好是 tool：
    # 直接拼就是「user, tool, ...」，接口会 400（tool 必须紧跟 tool_calls）。
    # 所以拼完统一过一遍配对，把拆散的调用整组丢掉。
    return _pair_tools(head + pinned + tail)


def _record(
    messages: list[dict[str, Any]],
    assistant: dict[str, Any],
    call: dict[str, Any] | None,
    result: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """把"模型说了什么"和"工具返回了什么"都记进历史（原样，不改写）。"""
    out = messages + [assistant]
    if call is not None:
        raw = json.dumps(result or {"ok": True}, ensure_ascii=False)
        if len(raw) > RECORD_KEEP:
            raw = raw[:RECORD_KEEP] + "…（这一条太长，已截断；要完整原文用 look 读那一个文件）"
        out = out + [{"role": "tool", "tool_call_id": call.get("id", ""), "content": raw}]
    return out


def step(
    messages: list[dict[str, Any]],
    files: dict[str, str],
    round_no: int,
    pending_search: str = "",
    observed: set[str] | None = None,
) -> dict[str, Any]:
    """跑一轮，返回下一个动作。"""
    global _TOKENS
    _TOKENS = 0
    if pending_search:
        error = ""
        try:
            results = search.dedupe(search.query(pending_search))
            detail = search.render(results)
        except search.SearchError as exc:
            results = []
            error = str(exc)
            detail = f"搜索失败：{error}"
        event: dict[str, Any] = {
            "action": "search",
            "query": pending_search,
            "results": results,
        }
        if error:
            event["error"] = error
        return {
            "event": event,
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

    # 新一轮的第一跳：把当前项目清单附在最后。
    # 不放进 system（会破掉前缀缓存），也不写进 sess.messages（只在这次请求里用）。
    # 有了它，模型不用先 look("") 就知道有哪些文件、多大，才能判断该改哪个、该不该删。
    ambient: list[dict[str, Any]] = []
    if round_no == 0:
        ambient = [{"role": "user", "content": f"当前项目：\n{manifest(files)}"}]

    try:
        action, assistant, call = _call([system, *_recent(messages), *ambient])
    except TruncatedError:
        # 被截断时给一次机会：提示它把文件拆小，再试一轮
        nudge = {
            "role": "user",
            "content": "上一次输出被截断了。把这次要写的内容精简，必要时拆成两个文件，一次只写一个。",
        }
        action, assistant, call = _call([system, *_recent(messages), *ambient, nudge])

    if action["action"] == "ask":
        return {"event": action, "messages": _record(messages, assistant, call), "stop": True}

    if action["action"] in {"say", "finish"}:
        text = action.get("text", "")
        missing = claims_missing(text, files)
        # 另一种假宣称：说「index.html 已经换成登录页」，但这一轮一次写操作都没做。
        # 只查文件存不存在拦不住它——文件在，内容没变。
        stale = claims_changed(text, touched_paths(messages))
        targets = missing or stale
        too_long = len(text) > SAY_TOO_LONG
        demand = ""
        if missing:
            demand = (
                f"你在回复里提到 {', '.join(missing)}，但项目里没有这个文件。"
                "不要只说，直接调用 write_file 把它写出来。"
            )
        elif stale:
            demand = (
                f"你说 {', '.join(stale)} 已经改过了，但这一轮没有对它执行任何写操作。"
                "不要只说，直接调用 edit_file 或 write_file 把改动落下去。"
            )
        elif too_long:
            # 对话只留结论：成段的解释、清单、示例代码都得是文件
            demand = (
                f"这段话有 {len(text)} 字，太长。把里面的解释、步骤、对比、示例代码"
                "用 write_file 写成文件（说明写 .md，代码写代码文件），"
                "对话里只留两三句结论，并告诉用户看哪个文件。"
            )

        if demand:
            retry_messages = _record(messages, assistant, call, {"ok": False, "error": demand})
            retry_action, retry_assistant, retry_call = _call(
                [system, *_recent(retry_messages), {"role": "user", "content": demand}]
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
            # 退回来的这句已经收短了：用它，别把结论丢了
            if not targets and retry_action["action"] in {"say", "finish"}:
                short = str(retry_action.get("text") or "").strip()
                if short and len(short) <= SAY_TOO_LONG:
                    return {
                        "event": {**retry_action, "text": short},
                        "messages": _record(retry_messages, retry_assistant, retry_call),
                        "stop": True,
                    }
            return {
                "event": {
                    "action": "say",
                    "text": (
                        f"我还没真的动过 {', '.join(targets)}，刚才那句不算。再说一次我就动手。"
                        if targets
                        else "这段说得太长了，先写成文件，再说结论。"
                    ),
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
        if path:
            if path in files:
                if observed is not None:
                    observed.add(path)
                detail = read_content(files, [path])
                # 读全文，不截断：拆文件 / 改一段都要逐字对原文，
                # 截了模型就只能凭印象整份重写（实测踩过）
                result = {"ok": True, "content": detail}
            else:
                detail = f"{path} 不存在。\n{manifest(files)}"
                result = {"ok": False, "error": detail[:6000]}
        else:
            if observed is not None:
                observed.update(files)
            detail = manifest(files)
            result = {"ok": True, "content": detail[:6000]}
        return {
            "event": action,
            "messages": _record(messages, assistant, call, result),
        }

    if action["action"] in {"write", "edit", "delete"}:
        state, problem = apply_fs(action, files, observed)
        if problem:
            # 「没先 look 就删」「文件已存在」这类是这一小步被拦下，不是系统故障：
            # 错误原样写回历史，下一跳它会照做；界面上按过程显示，不弹红条。
            return {
                "event": {
                    "action": "blocked",
                    "tool": action["action"],
                    "path": action.get("path", ""),
                    "text": problem,
                },
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
        return {
            "event": action,
            "messages": _record(messages, assistant, call, result),
            "files": state,
        }

    # think / plan 不结束这一轮，继续往下走
    return {
        "event": action,
        "messages": _record(messages, assistant, call),
        "stop": action["action"] not in {"think", "plan"},
    }
