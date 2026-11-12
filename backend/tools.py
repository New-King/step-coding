"""工具定义：schema、名字映射、参数解析。

只有这一份 schema：既交给模型，也用于把 tool_call 翻译成动作。
"""

from __future__ import annotations

import json
from typing import Any


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


def loads(text: str) -> dict[str, Any]:
    for candidate in (text or "", (text or "").replace("\n", "\\n")):
        try:
            value = json.loads(candidate, strict=False)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return {}


