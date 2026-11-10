"""把"要改什么"讲成一组最小操作。

模型不再交回整份文件，而是交回 ops：

  create  新建文件（从头写）
  append  在文件末尾接着写
  edit    找到一段原文，换成新的（真正改代码的样子）
  delete  删掉文件

后端会按顺序模拟一遍，确认每个 edit 的原文真的在当前内容里；
对不上就让模型重来一次（只重来一次，不无限循环）。
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

MAX_FLOW = 4
MAX_OPS = 14
MAX_LINES = 200


class ExplainError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(API_KEY)


SYSTEM = """你是一个很会讲代码的人，也是干活的。用户想弄懂一件事，或者让你改一点东西。

只输出一个 JSON 对象，不要解释。

打招呼、问你能干什么、还没想清楚 → 只回一句：
{"action": "reply", "text": "一句话，自然点"}

要动手 → 交回一组操作（ops），不要交回整份文件：

{
  "action": "build",
  "title": "这次在做什么，14 字以内",
  "summary": "一句话，40 字以内",
  "kind": "concept | flow | ui",
  "flow": [{"label": "角色名", "desc": "它在干什么，20 字以内"}],
  "ops": [
    {"kind": "create", "path": "index.html", "lang": "html",
     "label": "页面骨架", "focus": 0, "code": "整个文件的初始内容"},

    {"kind": "append", "path": "style.css",
     "label": "补上提示文字样式", "focus": 2, "code": "接在文件末尾的一段"},

    {"kind": "edit", "path": "index.html",
     "label": "注册链接指向新页面", "focus": 1,
     "find": "从当前文件里原样复制的一小段",
     "replace": "换成这一段"},

    {"kind": "delete", "path": "old.js", "label": "删掉没用的脚本"}
  ]
}

硬性要求：
1. **改已有的文件只能用 edit 或 append，不能再用 create 整份覆盖。**
   create 只用于这一轮新出现的文件。
2. edit 的 find 必须是**从当前文件内容里逐字复制的片段**（含缩进和换行），
   短到够定位就行（一行到几行）。找不到就会失败重试。
3. edit 只改必须改的那几行。不要为了加一个链接把整个文件重写。
4. 有改动才写 op。没动的文件不要出现在 ops 里。
5. ops 3～14 个，总代码控制在 200 行以内。宁可少做一点。
6. 只留主干：不要 import、不要构建配置、不要错误处理样板、不要大段注释。
   但语法必须是真实语言的，能直接抄走。不要伪代码。
7. flow 可选：讲流程时给 2～4 个节点，并用 focus 指向当前节点；
   写界面时给空数组 []。
8. 语言跟随项目里已有的技术栈；空项目按最合适的来。

什么时候 reply 而不是 build：
- 打招呼、寒暄、问你是谁 / 能干什么
- 追问上一段代码是什么意思（能用话讲清就别改代码）
- 连做什么都没说清（比如只说了"帮我搞个东西"）

注意：风格、配色、布局这类细节不要问，自己选一个合理的直接做。
一次只问一个问题。

reply 的语气：像同事说话，短。不要"您好！我是您的编程助手"。"""


def _chat(messages: list[dict[str, str]]) -> dict[str, Any]:
    if not API_KEY:
        raise ExplainError("未配置 DEEPSEEK_API_KEY")

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
        raise ExplainError(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ExplainError(f"网络错误: {exc}") from exc

    content = (data["choices"][0].get("message") or {}).get("content") or ""
    if not content.strip():
        raise ExplainError("模型没有返回内容")
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise ExplainError("模型返回的不是合法 JSON") from exc


def render_context(files: dict[str, str]) -> str:
    if not files:
        return "当前项目是空的，还没有任何文件。"
    parts = ["当前已有的文件（原样，含缩进）："]
    for path, body in files.items():
        parts.append(f"\n=== {path} ===\n{body.rstrip()}")
    return "\n".join(parts)


def _apply(ops: list[dict[str, Any]], files: dict[str, str]) -> tuple[dict[str, str], list[dict]]:
    """按顺序模拟一遍，顺便记下对不上的地方。"""
    state = dict(files)
    problems: list[dict] = []

    for i, op in enumerate(ops, start=1):
        kind = op["kind"]
        path = op["path"]
        if kind == "create":
            state[path] = op["code"]
        elif kind == "append":
            state[path] = state.get(path, "") + op["code"]
        elif kind == "edit":
            body = state.get(path, "")
            idx = body.find(op["find"])
            if idx < 0:
                problems.append(
                    {"path": path, "reason": f"第 {i} 个 edit「{op['label']}」的 find 在 {path} 里找不到"}
                )
                continue
            state[path] = body[:idx] + op["replace"] + body[idx + len(op["find"]):]
        elif kind == "delete":
            state.pop(path, None)

    return state, problems


KIND_ALIAS = {
    "create": "create", "write": "create", "new": "create", "add_file": "create",
    "append": "append", "insert": "append", "add": "append", "extend": "append",
    "edit": "edit", "replace": "edit", "str_replace": "edit", "update": "edit",
    "modify": "edit", "patch": "edit",
    "delete": "delete", "remove": "delete", "rm": "delete",
}


def _ops(raw: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in (raw.get("ops") or [])[:MAX_OPS]:
        kind = KIND_ALIAS.get(str(item.get("kind") or "").strip().lower(), "")
        path = str(item.get("path") or "").strip().lstrip("/")
        if not path or not kind:
            continue
        label = str(item.get("label") or "继续").strip()[:24]
        try:
            focus = int(item.get("focus", 0))
        except (TypeError, ValueError):
            focus = 0
        op: dict[str, Any] = {"kind": kind, "path": path, "label": label, "focus": max(0, focus)}

        if kind in {"create", "append"}:
            code = item.get("code") or ""
            if not isinstance(code, str) or not code.strip():
                continue
            if not code.endswith("\n"):
                code += "\n"
            op["code"] = code
            op["lang"] = str(item.get("lang") or "").lower()[:16]
        elif kind == "edit":
            find = item.get("find") or item.get("old") or item.get("search") or ""
            replace = item.get("replace") or item.get("new") or item.get("with") or ""
            if not isinstance(find, str) or not find.strip():
                continue
            if not isinstance(replace, str):
                continue
            op["find"] = find
            op["replace"] = replace
        out.append(op)
    return out


def _lines(text: str) -> int:
    return len([ln for ln in text.splitlines() if ln.strip()])


def _lesson(raw: dict[str, Any], state: dict[str, str], ops: list[dict[str, Any]]) -> dict[str, Any]:
    flow = []
    for item in (raw.get("flow") or [])[:MAX_FLOW]:
        label = str(item.get("label") or "").strip()
        if not label:
            continue
        flow.append({"label": label[:12], "desc": str(item.get("desc") or "").strip()[:40]})
    if len(flow) < 2:
        flow = []

    for op in ops:
        op["focus"] = max(0, min(len(flow) - 1, op["focus"])) if flow else -1

    files = []
    for path, body in state.items():
        lang = next((o.get("lang") for o in ops if o["path"] == path and o.get("lang")), "")
        if not lang:
            lang = _guess_lang(path)
        files.append({"path": path, "lang": lang})

    total = sum(_lines(s) for s in state.values())
    return {
        "title": str(raw.get("title") or "这次改动").strip()[:30],
        "summary": str(raw.get("summary") or "").strip()[:60],
        "kind": str(raw.get("kind") or "concept").strip()[:12],
        "files": files,
        "flow": flow,
        "ops": ops,
        "lines": total,
        "tooLong": total > 120,
    }


def _guess_lang(path: str) -> str:
    if path.endswith(".html"):
        return "html"
    if path.endswith(".css"):
        return "css"
    if path.endswith(".py"):
        return "python"
    if path.endswith(".go"):
        return "go"
    return "javascript"


def converse(
    messages: list[dict[str, str]], files: Optional[dict[str, str]] = None
) -> dict[str, Any]:
    """一轮对话：回一句话，或者交回一组操作。"""
    current = files or {}
    msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
    if current:
        msgs.append({"role": "system", "content": render_context(current)})
    msgs.extend(messages)

    raw = _chat(msgs)
    if str(raw.get("action", "build")) == "reply":
        said = str(raw.get("text") or "").strip()
        if not said:
            raise ExplainError("模型没说话")
        return {"action": "reply", "text": said[:200]}

    ops = _ops(raw)
    if not ops:
        raise ExplainError("这一轮没有要做的改动")

    state, problems = _apply(ops, current)

    if problems:
        # 改的地方对不上原文：把问题交回去，只重试一次
        msgs.append({"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)})
        msgs.append(
            {
                "role": "user",
                "content": (
                    "这些改动和当前文件对不上：\n"
                    + "\n".join(f"- {p['reason']}" for p in problems)
                    + "\n请重新输出 ops。edit 的 find 必须是从上面的文件内容里逐字复制的片段，"
                    "包含原来的缩进。"
                ),
            }
        )
        raw = _chat(msgs)
        ops = _ops(raw)
        if ops:
            state, problems = _apply(ops, current)

    if problems:
        # 还是对不上：退一步，整份重写受影响的文件（能做成就行，别卡住）
        bad = sorted({p["path"] for p in problems})
        print(f"[explain] 定位失败，改为整份重写: {bad}", flush=True)
        msgs.append({"role": "assistant", "content": json.dumps(raw, ensure_ascii=False)})
        msgs.append(
            {
                "role": "user",
                "content": (
                    f"改用整份重写：把 {', '.join(bad)} 用 create 重新给出完整内容，"
                    "其他文件不要动。这一轮不要再使用 edit。"
                ),
            }
        )
        raw = _chat(msgs)
        # 只认这些文件的 create，其余一概忽略，保证这一轮一定落地
        ops = [o for o in _ops(raw) if o["kind"] == "create" and o["path"] in bad]
        if not ops:
            raise ExplainError("没定位到要改的那一段，换个说法我再试一次")
        state, problems = _apply(ops, current)
        if problems:
            raise ExplainError("要改的地方和原文对不上，换个说法我再试一次")

    return {"action": "build", "lesson": _lesson(raw, state, ops)}


def generate(question: str) -> dict[str, Any]:
    """从零开始（空项目）。"""
    return converse([{"role": "user", "content": f"我想弄懂：{question}"}], {})