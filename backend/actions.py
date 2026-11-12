"""把模型的 tool_call 翻译成项目内部的动作。

这里是唯一做"参数校验"的地方：缺什么字段、路径空不空、问题有没有内容，
全在这一处判断，循环那边只处理合法动作。
"""

from __future__ import annotations

from typing import Any

from .agent_error import AgentError

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

    return {"action": "finish", "text": str(raw.get("text") or "").strip()[:120]}


