"""测试用的假模型回复：完全绕过网络，只验证循环和工具执行。"""

from __future__ import annotations

import json
from typing import Any, Callable

from backend.agent_error import TruncatedError  # noqa: F401  (测试里也会用到)

ACTION_TO_TOOL = {
    "think": "think",
    "look": "look",
    "search": "search",
    "plan": "plan",
    "ask": "ask",
    "say": "say",
    "write": "write_file",
    "edit": "edit_file",
    "delete": "delete_file",
    "finish": "finish",
    "decline": "decline",
}


def reply(action: dict[str, Any], idx: int = 1):
    """把内部动作包装成 (action, assistant, tool_call)。"""
    args = {k: v for k, v in action.items() if k != "action"}
    if action["action"] == "write" and "code" in args:
        args["content"] = args.pop("code")
    call = {
        "id": f"call-{idx}",
        "type": "function",
        "function": {
            "name": ACTION_TO_TOOL[action["action"]],
            "arguments": json.dumps(args, ensure_ascii=False),
        },
    }
    assistant = {"role": "assistant", "content": "", "tool_calls": [call]}
    return action, assistant, call


def scripted(actions: list[dict[str, Any]]) -> Callable[[list[dict[str, Any]]], tuple]:
    """按顺序返回预设动作；次数用完就报错，避免测试悄悄多跑一轮。"""
    queue = list(actions)
    calls = {"n": 0}

    def _call(messages: list[dict[str, Any]]):
        calls["n"] += 1
        if not queue:
            raise AssertionError("假模型的动作已经用完，说明循环多要了一轮")
        action = queue.pop(0)
        return reply(action, calls["n"])

    _call.calls = calls  # type: ignore[attr-defined]
    _call.remaining = lambda: len(queue)  # type: ignore[attr-defined]
    return _call