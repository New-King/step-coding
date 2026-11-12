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


class AgentError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(API_KEY)


SYSTEM = """你是一个在小项目里干活的工程师。每一轮只调用一个工具，不要解释。

工具：
think(text)              说清正在确认什么、打算怎么做
look(path)               看项目内容，空字符串表示整个项目
search(query)            联网查资料（确定的事不要查）
plan(steps)              列出接下来几步
ask(questions)           缺关键信息时提问，一次最多 4 个，可带互斥选项
say(text)                只回一句话结束这一轮（寒暄、解释）
write_file(path, content, lang, label)   新建或整体覆盖一个文件
edit_file(path, find, replace, label)    把文件里的一段换成新内容
delete_file(path, label) 删除一个文件
finish(text)             做完时调用，附一句总结
decline(text, suggestions) 超出范围时礼貌说明

你的范围：写代码、讲代码、看项目、改项目。
超出范围的需求不要直接去做，也不要用 search 去查——用 decline。

**拒绝不是关门，是把需求翻译成你能做的事。**
1. 先说中对方的真实目的（证明你听懂了）
2. 只否定你做不到的那一小块，一句话，不说教
3. 立刻给 1～3 个用代码能达到同一目的的做法，具体到能开工
4. 语气像同事：不道歉三遍，不讲大道理

工作方式：
1. 先 think，说明打算怎么做、要几个文件。
2. 需要看现状就 look（新项目也看一眼根目录）。
3. 只在**不确定**或需要**最新信息**时才 search。你确定的事不要搜。
4. 然后 plan 列出步骤。
5. 一次写一个文件；已有内容的文件用 edit_file，不要整体覆盖。
6. 写完会收到"已写入 x（n 行）"，那就是落盘凭证；不要重复写同一个文件。
7. 全部做完再 finish。

什么时候 say（只回一句，结束这一轮）：
- 打招呼、寒暄、道谢
- 问你是谁、能做什么
→ 别把寒暄变成问卷。

什么时候 ask：
- 判据只有一条：缺了某个信息就没法正确开工
- 该问：要连真实接口但没有地址/密钥、技术栈决定完全不同的实现、
  两种理解都说得通、要删除或覆盖已有内容
- 不该问：配色、字号、文件名、目录层级——自己定
- 没有具体选项就用 say 问，不要硬凑选项

**say 和 finish 都不能宣称写了某个文件**——文件必须通过 write_file / edit_file 真的落地。

约束（通用）：
- 一轮只调用一个工具。
- 文件内容必须完整、能直接运行；不要伪代码、不要"此处省略"。
- edit_file 的 find 必须逐字照抄现有内容（含缩进）。
- 文件数量和代码长度跟任务规模匹配，别为了完整而堆砌。
- 不要引入构建工具、包管理、TypeScript、框架，除非用户明确要。
- 不要虚构外部资源（API 地址、密钥、图片链接）；需要就 ask。
- 说话简短，像同事，不要客套。"""


FILE_MARKER = "\n<<<FILE>>>\n"


def _split(text: str) -> tuple[str, str]:
    """元数据 JSON + 原样正文。正文部分不做任何转义。"""
    if FILE_MARKER in text:
        head, body = text.split(FILE_MARKER, 1)
        return head, body
    return text, ""


def _parse(text: str) -> dict[str, Any] | None:
    """尽量从模型输出里抠出 JSON：可能带 ``` 围栏，也可能前后有废话。"""
    import re as _re

    body = text.strip()
    fence = _re.search(r"```(?:json)?\s*(.+?)```", body, _re.S)
    if fence:
        body = fence.group(1).strip()

    # strict=False：允许字符串里出现未转义的换行/制表符
    # （模型贴大段 Markdown 或代码时最常犯这个）
    try:
        value = json.loads(body, strict=False)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass

    start, end = body.find("{"), body.rfind("}")
    if start >= 0 and end > start:
        chunk = body[start : end + 1]
        for candidate in (chunk, chunk.replace("\n", "\\n").replace("\r", "")):
            try:
                value = json.loads(candidate, strict=False)
                return value if isinstance(value, dict) else None
            except json.JSONDecodeError:
                continue
    return None


def _chat(messages: list[dict[str, str]]) -> dict[str, Any]:
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 4000,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise AgentError(f"模型返回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AgentError(f"连不上模型：{exc}") from exc

    content = (data["choices"][0].get("message") or {}).get("content") or ""
    if not content.strip():
        raise AgentError("模型没有返回内容")

    head, file_body = _split(content)
    parsed = _parse(head)
    if parsed is not None:
        if file_body:
            parsed["_body"] = file_body
        return parsed

    # 不合法就再来一次，把要求说得更死
    print(f"[agent] 非法 JSON，尾部片段: {content[-120:]!r}", flush=True)
    payload["messages"] = messages + [
        {"role": "assistant", "content": content[:2000]},
        {
            "role": "user",
            "content": "上面不是合法 JSON。重新输出一个合法的 JSON 对象，只输出对象本身，"
            "不要代码块标记；字符串里的换行必须写成 \\n。",
        },
    ]
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            retried = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise AgentError(f"重试失败：{exc}") from exc

    content2 = (retried["choices"][0].get("message") or {}).get("content") or ""
    head2, file_body2 = _split(content2)
    parsed2 = _parse(head2)
    if parsed2 is None:
        raise AgentError("模型这次还是没给出合法 JSON")
    if file_body2:
        parsed2["_body"] = file_body2
    return parsed2


PATHISH = re.compile(r"[\w./-]+\.(?:js|mjs|html|css|py|go|ts|tsx|json|md|sh|rb|java|c|cpp)")


def _claims_missing(text: str, files: dict[str, str]) -> list[str]:
    """说了"我写了 a.js"，但项目里没有这个文件——这是假宣称。"""
    missing = []
    for raw in PATHISH.findall(text or ""):
        name = raw.lstrip("./")
        if not name:
            continue
        if name in files:
            continue
        if any(k.endswith("/" + name) or k == name for k in files):
            continue
        missing.append(name)
    return missing


def _tree(files: dict[str, str]) -> str:
    if not files:
        return "项目是空的，一个文件都没有。"
    lines = ["项目现有文件："]
    for path, body in files.items():
        lines.append(f"  {path}（{len(body.splitlines())} 行）")
    return "\n".join(lines)


def _context(files: dict[str, str], focus: str | None = None) -> str:
    if not files:
        return "项目是空的。"
    parts = [_tree(files)]
    targets = [focus] if focus else list(files)
    for path in targets:
        body = files.get(path)
        if body is None:
            continue
        parts.append(f"\n=== {path} ===\n{body.rstrip()}")
    return "\n".join(parts)


def _apply(action: dict[str, Any], files: dict[str, str]) -> tuple[dict[str, str], str | None]:
    """把动作落到文件上。返回新文件表和可能的错误说明。"""
    state = dict(files)
    kind = action["action"]

    if kind == "write":
        state[action["path"]] = action["code"]
    elif kind == "edit":
        body = state.get(action["path"], "")
        idx = body.find(action["find"])
        if idx < 0:
            return state, f"在 {action['path']} 里找不到要替换的那一段"
        state[action["path"]] = body[:idx] + action["replace"] + body[idx + len(action["find"]):]
    elif kind == "delete":
        state.pop(action["path"], None)
    return state, None


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    kind = str(raw.get("action") or "").strip().lower()
    if kind not in {
        "think", "look", "search", "plan", "say", "ask", "write", "edit",
        "delete", "finish", "decline"
    }:
        raise AgentError(f"不认识的动作：{kind or '(空)'}")

    if kind == "think":
        return {"action": "think", "text": str(raw.get("text") or "").strip()[:200]}
    if kind == "look":
        return {"action": "look", "path": str(raw.get("path") or "").strip().lstrip("/")}
    if kind == "say":
        text = str(raw.get("text") or "").strip()
        if not text:
            raise AgentError("say 没有内容")
        return {"action": "say", "text": text[:200]}
    if kind == "decline":
        text = str(raw.get("text") or "").strip()
        if not text:
            raise AgentError("decline 没有给出说明")
        ideas = [str(x).strip()[:40] for x in (raw.get("suggestions") or []) if str(x).strip()]
        return {"action": "decline", "text": text[:200], "suggestions": ideas[:3]}
    if kind == "search":
        text = str(raw.get("query") or "").strip()
        if not text:
            raise AgentError("search 没有给出 query")
        return {"action": "search", "query": text[:120]}
    if kind == "plan":
        steps = [str(s).strip()[:24] for s in (raw.get("steps") or []) if str(s).strip()]
        if not steps:
            raise AgentError("plan 没有给出步骤")
        return {"action": "plan", "steps": steps[:8]}
    if kind == "ask":
        questions: list[dict[str, Any]] = []
        raw_questions = raw.get("questions")

        if isinstance(raw_questions, list) and raw_questions:
            for item in raw_questions[:4]:
                text = str(item.get("question") or "").strip()
                if not text:
                    continue
                opts = []
                for o in (item.get("options") or [])[:4]:
                    label = o.get("label") if isinstance(o, dict) else o
                    label = str(label or "").strip()
                    if label:
                        opts.append(label[:40])
                questions.append({"question": text[:120], "options": opts})
        else:
            # 兼容单个问题的老格式
            text = str(raw.get("question") or "").strip()
            if text:
                opts = [str(o).strip()[:40] for o in (raw.get("options") or []) if str(o).strip()]
                questions.append({"question": text[:120], "options": opts[:4]})

        if not questions:
            raise AgentError("ask 没有给出问题")
        return {"action": "ask", "questions": questions}
    if kind == "write":
        code = raw.get("code") or ""
        if not str(code).strip() and raw.get("_body"):
            code = raw["_body"]
        path = str(raw.get("path") or "").strip().lstrip("/")
        if not path or not isinstance(code, str) or not code.strip():
            raise AgentError("write 缺少路径或内容")
        if not code.endswith("\n"):
            code += "\n"
        return {
            "action": "write",
            "path": path,
            "lang": str(raw.get("lang") or "").lower()[:16],
            "label": str(raw.get("label") or "新建文件").strip()[:24],
            "code": code,
        }
    if kind == "edit":
        path = str(raw.get("path") or "").strip().lstrip("/")
        find = raw.get("find") or ""
        replace = raw.get("replace") or ""
        if not str(replace).strip() and raw.get("_body"):
            replace = raw["_body"]
        if not path or not isinstance(find, str) or not find.strip():
            raise AgentError("edit 缺少路径或 find")
        return {
            "action": "edit",
            "path": path,
            "label": str(raw.get("label") or "改一处").strip()[:24],
            "find": find,
            "replace": replace if isinstance(replace, str) else "",
        }
    if kind == "delete":
        path = str(raw.get("path") or "").strip().lstrip("/")
        if not path:
            raise AgentError("delete 缺少路径")
        return {"action": "delete", "path": path, "label": str(raw.get("label") or "删除").strip()[:24]}

    return {"action": "finish", "text": str(raw.get("text") or "").strip()[:120]}


TOOL_NAME_TO_ACTION = {
    "think": "think", "look": "look", "search": "search", "plan": "plan",
    "ask": "ask", "say": "say", "write_file": "write", "edit_file": "edit",
    "delete_file": "delete", "finish": "finish", "decline": "decline",
}


def _spec(name: str, desc: str, props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": required,
            },
        },
    }


TOOLS: list[dict[str, Any]] = [
    _spec("think", "说清正在确认什么、打算怎么做（不改变任何东西）。",
          {"text": {"type": "string", "description": "60 字以内"}}, ["text"]),
    _spec("look", "读项目当前内容；path 为空表示看整个项目。",
          {"path": {"type": "string"}}, ["path"]),
    _spec("search", "联网查资料（API 用法、报错原因、最新写法）。确定的事不要查。",
          {"query": {"type": "string"}}, ["query"]),
    _spec("plan", "列出接下来几步，让用户知道你要干什么。",
          {"steps": {"type": "array", "items": {"type": "string"}}}, ["steps"]),
    _spec("ask", "缺关键信息没法开工时提问，一次最多 4 个问题，可带互斥选项。",
          {"questions": {"type": "array", "items": {
              "type": "object",
              "properties": {
                  "question": {"type": "string"},
                  "options": {"type": "array", "items": {"type": "string"}},
              },
              "required": ["question"],
          }}}, ["questions"]),
    _spec("say", "只回一句话结束这一轮（寒暄、解释）。不能用来宣称文件已写好。",
          {"text": {"type": "string"}}, ["text"]),
    _spec("write_file", "新建或整体覆盖一个文件。内容必须是完整的、能直接运行的。",
          {"path": {"type": "string"}, "lang": {"type": "string"},
           "label": {"type": "string", "description": "这一步在做什么，12 字以内"},
           "content": {"type": "string", "description": "完整文件内容"}},
          ["path", "content"]),
    _spec("edit_file", "把文件里的一段原文换成新内容。find 必须逐字照抄现有内容。",
          {"path": {"type": "string"}, "label": {"type": "string"},
           "find": {"type": "string"}, "replace": {"type": "string"}},
          ["path", "find", "replace"]),
    _spec("delete_file", "删除项目里的一个文件。",
          {"path": {"type": "string"}, "label": {"type": "string"}}, ["path"]),
    _spec("finish", "这件事做完了，附一句总结。",
          {"text": {"type": "string"}}, ["text"]),
    _spec("decline", "超出范围时礼貌说明，并用代码给出可达成的替代。",
          {"text": {"type": "string"},
           "suggestions": {"type": "array", "items": {"type": "string"}}}, ["text"]),
]


def _loads(text: str) -> dict[str, Any]:
    for candidate in (text or "", (text or "").replace("\n", "\\n")):
        try:
            value = json.loads(candidate, strict=False)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return {}


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
    args = _loads(call.get("function", {}).get("arguments") or "{}")

    if "content" in args and "code" not in args:
        args["code"] = args.pop("content")

    action = _normalize({"action": TOOL_NAME_TO_ACTION.get(name, ""), **args})
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


REPEAT_THRESHOLDS = (3, 5, 8)

GENTLE = (
    "你连续三次调用了完全相同的工具和参数。先仔细看上一次的结果再决定下一步；"
    "如果这件事已经做完，直接 finish。"
)
FIRM = (
    "同一个调用已经重复五次了。换一种做法，或者直接 finish——重复不会让结果变好。"
)


def _call_key(message: dict[str, Any]) -> str | None:
    calls = message.get("tool_calls") or []
    if not calls:
        return None
    fn = calls[0].get("function") or {}
    args = _loads(fn.get("arguments") or "{}")
    return f"{fn.get('name','')}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"


def _repeat_streak(messages: list[dict[str, Any]]) -> int:
    """从末尾往前数，连续多少次是完全相同的工具调用。"""
    streak = 0
    last: str | None = None
    for m in reversed(messages):
        if m.get("role") != "assistant" or not m.get("tool_calls"):
            continue
        key = _call_key(m)
        if key is None:
            continue
        if last is None:
            last = key
            streak = 1
        elif key == last:
            streak += 1
        else:
            break
    return streak if last else 0


def step(
    messages: list[dict[str, Any]],
    files: dict[str, str],
    round_no: int,
    pending_search: str = "",
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

    ctx = _context(files)
    ability = (
        "当前有联网搜索能力，可以用 search 查资料。"
        if search.enabled()
        else "当前没有配置联网搜索，不要使用 search 工具。"
    )
    system = {"role": "system", "content": f"{SYSTEM}\n\n{ability}\n\n{ctx}"}

    # 重复调用：按 3 / 5 / 8 分级处理，先提醒，实在停不下来才收尾
    streak = _repeat_streak(messages)
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
        missing = _claims_missing(action.get("text", ""), files)
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
                state, problem = _apply(retry_action, files)
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
        if path and files.get(path):
            body = files[path]
            detail = f"=== {path}（{len(body.splitlines())} 行）===\n{body}"
        else:
            detail = _context(files)
        return {
            "event": action,
            "messages": _record(messages, assistant, call, {"ok": True, "content": detail[:6000]}),
        }

    if action["action"] in {"write", "edit", "delete"}:
        state, problem = _apply(action, files)
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
