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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

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


SYSTEM = """你是一个在小项目里干活的工程师。每一轮只做一个动作，输出一个 JSON 对象，不要解释。

可用动作：
{"action":"think","text":"我现在在确认什么、打算怎么做，60 字以内"}
{"action":"look","path":"目录或文件，空字符串表示项目根"}
{"action":"plan","steps":["做哪几步，每步 10 字以内"]}
{"action":"ask","question":"需要用户决定的事","options":["选项一","选项二"]}
{"action":"write","path":"a.html","lang":"html","label":"这一步在做什么，12 字以内","code":"完整文件内容"}
{"action":"edit","path":"a.html","label":"这一步在做什么","find":"从现有内容里逐字复制的一段","replace":"换成的内容"}
{"action":"delete","path":"x.js","label":"为什么删"}
{"action":"finish","text":"一句话总结做了什么"}

工作方式：
1. 先 think，说明你打算怎么看这件事、要做几个文件。
2. 需要看现状就先 look（新项目也要看一眼根目录，确认是不是空的）。
3. 然后 plan，把步骤列出来，让用户知道你要干什么。
4. 之后一次写一个文件。已经有内容的文件用 edit，不要用 write 整份覆盖。
5. 遇到必须用户决定的事（技术栈、风格、需要密钥、外部服务、要不要新增页面），
   用 ask，给 2～4 个选项。不要自己替用户决定。
6. 全部做完再 finish。

约束（通用，不要假设具体项目）：
- 一次只做一件事：这一轮只输出一个动作。
- write 的 code 必须是完整、能直接打开运行的；不要伪代码、不要"此处省略"。
- edit 的 find 必须逐字照抄现有内容（含缩进），只改必须改的那几行。
- 文件数量和代码长度跟任务规模匹配：小的演示 1～4 个文件，别为了完整而堆砌。
- 不要引入构建工具、包管理、TypeScript、框架，除非用户明确要。
- 不要虚构外部资源（API 地址、密钥、图片链接）；需要就 ask。
- 说话简短，像同事，不要客套。"""


def _chat(messages: list[dict[str, str]]) -> dict[str, Any]:
    if not API_KEY:
        raise AgentError("未配置 DEEPSEEK_API_KEY")

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
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
        raise AgentError(f"模型返回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AgentError(f"连不上模型：{exc}") from exc

    content = (data["choices"][0].get("message") or {}).get("content") or ""
    if not content.strip():
        raise AgentError("模型没有返回内容")
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise AgentError("模型返回的不是合法 JSON") from exc


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
    if kind not in {"think", "look", "plan", "ask", "write", "edit", "delete", "finish"}:
        raise AgentError(f"不认识的动作：{kind or '(空)'}")

    if kind == "think":
        return {"action": "think", "text": str(raw.get("text") or "").strip()[:200]}
    if kind == "look":
        return {"action": "look", "path": str(raw.get("path") or "").strip().lstrip("/")}
    if kind == "plan":
        steps = [str(s).strip()[:24] for s in (raw.get("steps") or []) if str(s).strip()]
        if not steps:
            raise AgentError("plan 没有给出步骤")
        return {"action": "plan", "steps": steps[:8]}
    if kind == "ask":
        question = str(raw.get("question") or "").strip()
        if not question:
            raise AgentError("ask 没有给出问题")
        options = [str(o).strip()[:24] for o in (raw.get("options") or []) if str(o).strip()]
        return {"action": "ask", "question": question[:120], "options": options[:4]}
    if kind == "write":
        code = raw.get("code") or ""
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


def step(messages: list[dict[str, str]], files: dict[str, str], round_no: int) -> dict[str, Any]:
    """跑一轮，返回下一个动作。"""
    if round_no >= MAX_ROUNDS:
        return {"event": {"action": "finish", "text": "步数到上限，先停在这里"}, "messages": messages}

    ctx = _context(files)
    msgs = [{"role": "system", "content": SYSTEM + "\n\n" + ctx}, *messages]

    raw = _chat(msgs)
    action = _normalize(raw)

    if action["action"] == "look":
        # look 不改文件，直接把看的结果塞回上下文
        path = action["path"]
        if path and files.get(path):
            body = files[path]
            detail = f"=== {path}（{len(body.splitlines())} 行）===\n{body}"
        else:
            detail = _context(files)
        messages = messages + [
            {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)},
            {"role": "user", "content": f"这是你要看的内容：\n{detail}"},
        ]
        return {"event": action, "messages": messages}

    if action["action"] in {"write", "edit", "delete"}:
        state, problem = _apply(action, files)
        if problem:
            messages = messages + [
                {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)},
                {"role": "user", "content": f"{problem}。请重新给出这个动作，find 要逐字照抄现有内容。"},
            ]
            return {
                "event": {"action": "error", "text": problem},
                "messages": messages,
                "files": files,
            }
        messages = messages + [
            {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}
        ]
        return {"event": action, "messages": messages, "files": state}

    messages = messages + [{"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}]
    return {"event": action, "messages": messages}