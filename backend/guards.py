"""两条守卫，都是从 DSH 的做法改来的。

1. 别撒谎：说"我写了 x.md"但项目里没有这个文件 → 把话退回去。
2. 别打转：连续重复同一个工具调用时分级提醒（DSH 的 thresholds 是 [3,5,8]）。

业务形态（单文件还是拆三份）不归这里管：每个用户的需求不一样，别拿全局规则替用户决定。
"""

from __future__ import annotations

import json
import re
from typing import Any

from .tools import TOOL_NAME_TO_ACTION, loads

FILE_NAME = r"[\w./-]+\.(?:js|mjs|html|css|py|go|ts|tsx|json|md|sh|rb|java|c|cpp)"
PATHISH = re.compile(FILE_NAME)
# 「index.html 已经换成登录表单了」这类宣称：文件在前、变更动词在后。
# 只认明确的变更动词，避免把「把 style.css 删掉」这种计划当成已完成。
CHANGE_CLAIM = re.compile(
    rf"({FILE_NAME})\s*(?:已经|已)?\s*"
    r"(?:换成|改成|改为|更新为|更新成|重写为|重写成|替换为|替换成|修改为|修改成)"
)
# 只有「写了/新建了 + 文件名」才算宣称。单纯提到某个文件名（"把 style.css 删掉"、
# "已删除 app.js"）不能当成"我说我写了它"——那样守卫会把正常的删除、合并回复退回去。
WRITE_CLAIM = re.compile(
    rf"(?:写好了|写好|写了|写入到?|新建|创建了?|生成了?|保存到|补充了?)\s*(?:文件\s*)?({FILE_NAME})"
)


def claims_missing(text: str, files: dict[str, str]) -> list[str]:
    """说了"我写了 a.js"，但项目里没有这个文件——这是假宣称。"""
    missing = []
    for raw in WRITE_CLAIM.findall(text or ""):
        name = raw.lstrip("./")
        if not name or name in missing:
            continue
        if name in files:
            continue
        if any(k.endswith("/" + name) or k == name for k in files):
            continue
        missing.append(name)
    return missing


def touched_paths(messages: list[dict[str, Any]]) -> set[str]:
    """本轮（最后一条用户消息之后）真正动过的文件路径。"""
    start = 0
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            start = i + 1
    paths: set[str] = set()
    for m in messages[start:]:
        for call in m.get("tool_calls") or []:
            fn = call.get("function") or {}
            if TOOL_NAME_TO_ACTION.get(fn.get("name", "")) not in {"write", "edit", "delete"}:
                continue
            args = loads(fn.get("arguments") or "{}")
            path = str(args.get("path") or "").lstrip("./")
            if path:
                paths.add(path)
    return paths


def claims_changed(text: str, touched: set[str]) -> list[str]:
    """说了"x 已经改过"，但这一轮根本没对它做写操作——这是另一种假宣称。"""
    stale = []
    for raw in CHANGE_CLAIM.findall(text or ""):
        name = raw.lstrip("./")
        if not name or name in stale:
            continue
        if name in touched or any(t.endswith("/" + name) for t in touched):
            continue
        stale.append(name)
    return stale


REPEAT_THRESHOLDS = (3, 5, 8)

GENTLE = (
    "你连续三次调用了完全相同的工具和参数。先仔细看上一次的结果再决定下一步；"
    "如果这件事已经做完，直接 finish。"
)
FIRM = (
    "同一个调用已经重复五次了。换一种做法，或者直接 finish——重复不会让结果变好。"
)


def call_key(message: dict[str, Any]) -> str | None:
    calls = message.get("tool_calls") or []
    if not calls:
        return None
    fn = calls[0].get("function") or {}
    args = loads(fn.get("arguments") or "{}")
    return f"{fn.get('name','')}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"


def repeat_streak(messages: list[dict[str, Any]]) -> int:
    """从末尾往前数，连续多少次是完全相同的工具调用。"""
    streak = 0
    last: str | None = None
    for m in reversed(messages):
        if m.get("role") != "assistant" or not m.get("tool_calls"):
            continue
        key = call_key(m)
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


