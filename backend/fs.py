"""文件操作：唯一能改文件的入口，带基本保护。

照 DSH 的 fs-observation-policy 思路：不声不响地覆盖已有内容是最容易出事的地方，
所以 write_file 默认只能"新建"；要覆盖已有文件必须显式 overwrite，
edit_file 则要求文件真的存在。
"""

from __future__ import annotations

from typing import Any

def apply(action: dict[str, Any], files: dict[str, str]) -> tuple[dict[str, str], str | None]:
    """把动作落到文件上。返回新文件表和可能的错误说明。"""
    state = dict(files)
    kind = action["action"]

    if kind == "write":
        path = action["path"]
        if path in state and not action.get("overwrite"):
            return (
                state,
                f"{path} 已经存在。要改内容请用 edit_file；确实要整体覆盖就带上 "
                f'overwrite=true 再调用 write_file。',
            )
        state[path] = action["code"]
    elif kind == "edit":
        path = action["path"]
        if path not in state:
            return state, f"{path} 不存在，先 write_file 建出来（FS_NOT_FOUND）"
        body = state[path]
        idx = body.find(action["find"])
        if idx < 0:
            return state, f"在 {path} 里找不到要替换的那一段（原文必须逐字照抄）"
        state[action["path"]] = body[:idx] + action["replace"] + body[idx + len(action["find"]):]
    elif kind == "delete":
        state.pop(action["path"], None)
    return state, None


