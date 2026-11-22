"""把模型的 tool_call 翻译成项目内部的动作。

这里是唯一做"参数校验"的地方：缺什么字段、路径空不空、问题有没有内容，
全在这一处判断，循环那边只处理合法动作。
"""

from __future__ import annotations

from typing import Any

from .agent_error import AgentError

# 回话正文的上限。这个产品卖的是「文字落成文件、对话只留结论」，
# 所以超长不往对话里塞：调用方拿到 SAY_TOO_LONG 以上的 say 会退回让模型写成文件。
# SAY_CHARS 只是兜底截断，防止模型硬塞几千字把界面顶爆。
SAY_CHARS = 600
# 总结句的软上限：超过它就不算「一句话」，会被要求改写成文件
SAY_TOO_LONG = 240


def _clip(text: str, limit: int) -> str:
    """超长兜底：宁可留个省略号，也别让它读起来像半句话。

    曾经 finish 被硬切到 120 字，模型说的「…只对小数做收敛。现在两份文件
    逻辑和断言一致。」在界面上变成「…只对小数做收敛。现」——看着像故障。
    """
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
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
        return {"action": "say", "text": _clip(text, SAY_CHARS)}
    if kind == "decline":
        text = str(raw.get("text") or "").strip()
        if not text:
            raise AgentError("decline 没有给出说明")
        ideas = [str(x).strip()[:40] for x in (raw.get("suggestions") or []) if str(x).strip()]
        return {"action": "decline", "text": _clip(text, SAY_CHARS), "suggestions": ideas[:3]}
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

        def one(item: Any) -> dict[str, Any] | None:
            # 模型有时直接给字符串数组（["要做的页面是？"]），不能当 dict 用
            if isinstance(item, str):
                text = item.strip()
                return {"question": text[:120], "options": []} if text else None
            if not isinstance(item, dict):
                return None
            text = str(item.get("question") or "").strip()
            if not text:
                return None
            opts = []
            for o in (item.get("options") or [])[:4]:
                label = o.get("label") if isinstance(o, dict) else o
                label = str(label or "").strip()
                if label:
                    opts.append(label[:40])
            return {"question": text[:120], "options": opts}

        if isinstance(raw_questions, list) and raw_questions:
            for item in raw_questions[:4]:
                question = one(item)
                if question:
                    questions.append(question)
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
            "overwrite": bool(raw.get("overwrite")),
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

    # 收尾也是给用户看的正文，别按「一行摘要」切：120 字会在句子中间断掉
    return {"action": "finish", "text": _clip(str(raw.get("text") or "").strip(), SAY_CHARS)}


