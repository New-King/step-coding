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


SYSTEM = """你是一个在小项目里干活的工程师。每一轮只做一个动作，输出一个 JSON 对象，不要解释。

可用动作：
{"action":"think","text":"我现在在确认什么、打算怎么做，60 字以内"}
{"action":"look","path":"目录或文件，空字符串表示项目根"}
{"action":"search","query":"要搜什么，一句话"}
{"action":"plan","steps":["做哪几步，每步 10 字以内"]}
{"action":"ask","questions":[
  {"question":"缺的关键信息，一句话","options":["选项一","选项二"]},
  {"question":"第二个问题（没有选项就是自由填写）"}
]}
{"action":"write","path":"a.html","lang":"html","label":"这一步在做什么，12 字以内","code":"很短的文内容，超过 20 行不要写在这里"}
{"action":"edit","path":"a.html","label":"这一步在做什么","find":"从现有内容里逐字复制的一段","replace":"很短才写这里"}
{"action":"delete","path":"x.js","label":"为什么删"}
{"action":"say","text":"只是回一句话，结束这一轮"}
{"action":"finish","text":"一句话总结做了什么"}
{"action":"decline","text":"先说中目的，再说做不到的那一点，最后给可开工的替代","suggestions":["贴着目的的替代一","替代二"]}

你的范围：写代码、讲代码、看项目、改项目。
超出范围的需求不要直接去做，也不要用 search 去查——用 decline 回答。

**拒绝不是关门，是把需求翻译成你能做的事。**按这个顺序写：

1. 先说中对方的真实目的（一句话，证明你听懂了）。
   对方要的往往不是那个具体形式，而是背后的结果。
2. 只否定你做不到的那一小块，一句话，不要否定整个需求，也不要说教。
3. 立刻给 1～3 个**用代码能达到同一目的**的做法，具体到能直接开工。
   要贴着对方的目的走，而不是硬转成"你要不要学编程"。
   想想：他想要的这个结果，能不能用一个页面、一个脚本、一次接口对接做出来？
4. 语气像同事：不道歉三遍，不讲大道理，不背声明。

suggestions 里放的就是第 3 步那几条，每条是一句可以直接开工的话

**写长文件不要塞进 JSON。** 内容超过 20 行（或含代码、Markdown）时，
第一行只写元数据 JSON（code / replace 留空），换行后写一行 `<<<FILE>>>`，
再把正文原样输出，不转义、不加代码块标记：

{"action":"write","path":"README.md","lang":"md","label":"写说明"}
<<<FILE>>>
# QuickSort

node quicksort.js

工作方式：
1. 先 think，说明你打算怎么看这件事、要做几个文件。
2. 需要看现状就先 look（新项目也要看一眼根目录，确认是不是空的）。
3. 只在**不确定**或需要**最新信息**时才 search（API 用法、报错原因、库的新写法）。
   你确定的事不要搜——搜一次花钱也拖时间。不确定用户环境里有没有的东西，问，不要猜。
   然后 plan，把步骤列出来。
4. 之后一次写一个文件。已经有内容的文件用 edit，不要用 write 整份覆盖。

5. **say 只用于对话，不能用来汇报"已经写好/改好"。**
   文件必须真的通过 write/edit 落到项目里，才算做完。
   finish 之前，这一轮至少要有一个真正的 write / edit / delete。

什么时候 say（只回一句话，结束这一轮，不给选项）：
   - 打招呼、寒暄、道谢、告别（"你好"、"谢谢"、"在吗"）
   - 问你是谁、能做什么
   - 用户只是随口说了一句，还没提出具体任务
   → 自然回一句，停下等用户。**别把寒暄变成问卷。**

6. 什么时候问（ask）：
   判据只有一条：**缺了某个信息，你就没法正确开工。**

   典型是该问的：
   - 要连真实接口/服务，但没有地址或密钥
   - 技术栈决定了完全不同的实现（React 还是原生、要不要后端）
   - 需求里两种理解都说得通，选错要重做
   - 用户要删除/覆盖已有内容，需要确认

   不该问的（自己定或直接做）：
   - 配色、字号、间距这类审美细节
   - 文件叫什么名字、放几层目录
   - "你想做什么"这种开放问题——用 say 问，别做成选项

   一次最多列 4 个问题，只列**真的缺的**，别把能自己定的也塞进去。
   每个问题的选项必须互斥、具体；没有明确选项就不给 options，让用户自由填。

7. 全部做完再 finish。写完一个文件后不要再重写它——除非明确发现内容坏了。
   每写完一个文件，系统会告诉你"已写入 x（n 行）"，这就是落盘成功的凭证。

约束（通用，不要假设具体项目）：
- 一次只做一件事：这一轮只输出一个动作。
- write 的 code 必须是完整、能直接打开运行的；不要伪代码、不要"此处省略"。
- edit 的 find 必须逐字照抄现有内容（含缩进），只改必须改的那几行。
- 文件数量和代码长度跟任务规模匹配：小的演示 1～4 个文件，别为了完整而堆砌。
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


def step(
    messages: list[dict[str, str]],
    files: dict[str, str],
    round_no: int,
    pending_search: str = "",
) -> dict[str, Any]:
    """跑一轮，返回下一个动作。

    pending_search 非空：界面已经显示过「正在搜」，这一轮只把结果抓回来补上。
    """
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
    if search.enabled():
        ability = "当前有联网搜索能力，可以用 search 查资料。"
    else:
        ability = "当前没有配置联网搜索，不要使用 search 动作。"
    msgs = [{"role": "system", "content": f"{SYSTEM}\n\n{ability}\n\n{ctx}"}, *messages]

    # 熔断：连续三次重复同一个动作，说明它卡住了
    tails = [
        m["content"]
        for m in messages[-6:]
        if m["role"] == "assistant" and m["content"].startswith("{")
    ]
    if len(tails) >= 3 and len(set(tails[-3:])) == 1:
        return {
            "event": {"action": "finish", "text": "这一步重复了三次，先停在这里。"},
            "messages": messages,
        }

    raw = _chat(msgs)
    action = _normalize(raw)

    if action["action"] == "ask":
        return {"event": action, "messages": messages + [
            {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}
        ], "stop": True}

    if action["action"] in {"say", "finish"}:
        missing = _claims_missing(action["text"], files)
        if missing:
            # 说了写了文件但根本不存在：逼它真的写出来（finish 也一样）
            demand = (
                f"你在回复里提到 {', '.join(missing)}，但项目里没有这个文件。"
                "不要只描述，直接给出这一轮的动作（write 或 edit），把文件真正写出来。"
            )
            messages = messages + [
                {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)},
                {"role": "user", "content": demand},
            ]
            msgs2 = [{"role": "system", "content": f"{SYSTEM}\n\n{ctx}"}, *messages]
            retry = _normalize(_chat(msgs2))
            if retry["action"] in {"write", "edit", "delete"}:
                state, problem = _apply(retry, files)
                if not problem:
                    messages = messages + [
                        {"role": "assistant", "content": json.dumps(retry, ensure_ascii=False)}
                    ]
                    return {"event": retry, "messages": messages, "files": state}
            return {
                "event": {
                    "action": "say",
                    "text": f"我还没真的写出 {', '.join(missing)}，刚才那句不算。再说一次我就动手。",
                },
                "messages": messages,
                "stop": True,
            }

        return {
            "event": action,
            "messages": messages
            + [{"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}],
            "stop": True,
        }

    if action["action"] == "decline":
        return {"event": action, "messages": messages + [
            {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}
        ], "stop": True}

    if action["action"] == "search":
        # 先把动作交回去（界面显示「正在搜」），结果下一轮再补
        return {
            "event": action,
            "messages": messages
            + [{"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}],
            "pending_search": action["query"],
        }

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

        done = ""
        if action["action"] == "write":
            body = state.get(action["path"], "")
            done = f"已写入 {action['path']}（{len(body.splitlines())} 行）。"
        elif action["action"] == "edit":
            done = f"已修改 {action['path']}。"
        else:
            done = f"已删除 {action['path']}。"

        messages = messages + [
            {"role": "assistant", "content": json.dumps(action, ensure_ascii=False)},
            {
                "role": "user",
                "content": (
                    f"{done}当前文件：{', '.join(state) or '无'}。"
                    "如果这件事已经做完就 finish；没做完就做下一步，不要重复同一个动作。"
                ),
            },
        ]
        return {"event": action, "messages": messages, "files": state}

    messages = messages + [{"role": "assistant", "content": json.dumps(action, ensure_ascii=False)}]
    return {"event": action, "messages": messages}