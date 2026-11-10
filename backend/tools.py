"""工具集：模型能做的事，全部在这里声明一次。

一份 schema 同时用于：交给模型的 tools 参数、执行时的参数校验、失败时的报错。
不再写两遍（之前 prompt 里写一遍、执行里再写一遍，改一处忘一处）。
"""

from __future__ import annotations

import subprocess
from typing import Any, Callable

from .workspace import Workspace, WorkspaceError

RUN_TIMEOUT = 60
OUTPUT_LIMIT = 4000


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


TOOLS: list[dict] = [
    _schema(
        "list_dir",
        "列出某个目录下的直接子项（不含递归）。path 为空表示项目根目录。",
        {"path": {"type": "string", "description": "相对路径，根目录传空字符串"}},
        ["path"],
    ),
    _schema(
        "read_file",
        "读取一个文件的完整内容。",
        {"path": {"type": "string"}},
        ["path"],
    ),
    _schema(
        "write_file",
        "创建或覆盖一个文件。content 必须是完整、可直接运行的内容。"
        "sections 可选：把文件切成几段并各配一句说明，前端会按段播报。",
        {
            "path": {"type": "string", "description": "相对路径，可包含目录"},
            "content": {"type": "string", "description": "完整文件内容"},
            "sections": {
                "type": "array",
                "description": "可选：分段，按顺序拼起来必须等于 content",
                "items": {
                    "type": "object",
                    "properties": {
                        "note": {"type": "string", "description": "这一段在做什么，12 字以内"},
                        "code": {"type": "string"},
                    },
                    "required": ["note", "code"],
                    "additionalProperties": False,
                },
            },
        },
        ["path", "content"],
    ),
    _schema(
        "mkdir",
        "创建一个空目录（会连同父级一起创建）。",
        {"path": {"type": "string"}},
        ["path"],
    ),
    _schema(
        "delete",
        "删除项目内的一个文件或空目录。",
        {"path": {"type": "string"}},
        ["path"],
    ),
    _schema(
        "move",
        "移动或重命名项目内的文件/目录。",
        {"from": {"type": "string"}, "to": {"type": "string"}},
        ["from", "to"],
    ),
    _schema(
        "run_command",
        "在项目根目录执行一条 shell 命令，返回 stdout/stderr 与退出码。"
        "用来安装依赖、跑构建、跑测试——靠输出自查。",
        {"command": {"type": "string"}},
        ["command"],
    ),
    _schema(
        "finish",
        "任务完成时调用，附一句总结。",
        {"summary": {"type": "string"}},
        ["summary"],
    ),
]


def _run(command: str, root: str) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"命令超过 {RUN_TIMEOUT}s 未结束", "exit": -1}
    except OSError as exc:
        return {"ok": False, "error": str(exc), "exit": -1}

    out = (proc.stdout or "")[-OUTPUT_LIMIT:]
    err = (proc.stderr or "")[-OUTPUT_LIMIT:]
    return {
        "ok": proc.returncode == 0,
        "exit": proc.returncode,
        "stdout": out,
        "stderr": err,
    }


def execute(name: str, args: dict[str, Any], ws: Workspace) -> dict[str, Any]:
    """执行一次工具调用。永远返回 dict，不抛异常——错误要回给模型看。"""
    try:
        if name == "list_dir":
            return ws.list_dir(args.get("path", ""))
        if name == "read_file":
            return ws.read(args["path"])
        if name == "write_file":
            content = args["content"]
            if not content.endswith("\n"):
                content += "\n"
            info = ws.write(args["path"], content)
            info["content"] = content
            return info
        if name == "mkdir":
            return ws.mkdir(args["path"])
        if name == "delete":
            return ws.delete(args["path"])
        if name == "move":
            return ws.move(args["from"], args["to"])
        if name == "run_command":
            if ws.root is None:
                return {"ok": False, "error": "还没有打开项目"}
            return _run(args["command"], str(ws.root))
        if name == "finish":
            return {"ok": True, "summary": args.get("summary", "")}
        return {"ok": False, "error": f"未知工具：{name}"}
    except WorkspaceError as exc:
        return {"ok": False, "error": str(exc)}
    except KeyError as exc:
        return {"ok": False, "error": f"缺少参数：{exc}"}
    except Exception as exc:  # noqa: BLE001 —— 工具失败不能让整个会话挂掉
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
