"""文件操作：唯一能改文件的入口，带基本保护。

照 DSH 的 fs-observation-policy 思路：不声不响地覆盖已有内容是最容易出事的地方，
所以 write_file 默认只能"新建"；要覆盖已有文件必须显式 overwrite，
edit_file 则要求文件真的存在。

另一条是「说到做到」的底线，必须在落盘这一层卡住，不能只写在提示词里：
正文不能是「内容见项目文件」这类占位说明（模型历史上被占位符污染过，真的会照抄）。

**不要在这里管业务形态**：单文件、拆三份、要不要内联，都由用户当次需求决定，
fs 只负责「写进来的必须是真正文」。
"""

from __future__ import annotations

import re
from typing import Any

# 占位符：曾经把历史里的正文换成「（已写入 app.js 的 6120 字符，内容见项目文件…）」，
# 模型照着这句话写文件，app.js 就真的只写了一句占位说明
PLACEHOLDER = re.compile(r"内容见项目文件|要改先 look|已写入 [^\n]{0,80}? 的 \d+ 字符")


def problem(body: str) -> str | None:
    """正文本身不合格就不许落盘。返回给模型看的错误说明。"""
    if PLACEHOLDER.search(body):
        return (
            "写进来的不是代码，是「内容见项目文件」这类占位说明。"
            "要写什么就把正文完整写出来；要改已有内容先 look 拿原文。"
        )
    return None


def apply(
    action: dict[str, Any],
    files: dict[str, str],
    observed: set[str] | None = None,
) -> tuple[dict[str, str], str | None]:
    """把动作落到文件上。返回新文件表和可能的错误说明。"""
    state = dict(files)
    kind = action["action"]

    if kind == "write":
        path = action["path"]
        if path in state and (observed is not None and path not in observed):
            return (
                state,
                f"你还没读过 {path}。先 look 一次，改动要照着原文来。",
            )
        # 覆盖已有文件必须显式 overwrite：改多大由模型判断，
        # 但「顺手整份覆盖」不能是默认动作（禁止覆盖也不行，实测它会改成删了重建，更吵）
        if path in state and not action.get("overwrite"):
            return (
                state,
                f"{path} 已经存在。改一处用 edit_file；整份重写就带上 overwrite=true。",
            )
        bad = problem(action["code"])
        if bad:
            return state, bad
        state[path] = action["code"]
    elif kind == "edit":
        path = action["path"]
        if path not in state:
            return state, f"{path} 不存在，先 write_file 建出来（FS_NOT_FOUND）"
        if observed is not None and path not in observed:
            return state, f"你还没读过 {path}。先 look 一次，照抄原文再 edit。"
        body = state[path]
        idx = body.find(action["find"])
        if idx < 0:
            return state, f"在 {path} 里找不到要替换的那一段（原文必须逐字照抄）"
        bad = problem(action["replace"])
        if bad:
            return state, bad
        state[action["path"]] = body[:idx] + action["replace"] + body[idx + len(action["find"]):]
    elif kind == "delete":
        path = action["path"]
        # 不存在的文件必须报错：静默成功会让模型以为删掉了，接着反复删同一个名字
        if path not in state:
            return state, f"{path} 不存在（可能已经删过了），不要重复删。"
        # 删掉再重写会绕过 overwrite 保护，所以删之前也得先看过
        if observed is not None and path not in observed:
            return state, f"你还没读过 {path}。删除或整份重写之前先 look 一次。"
        state.pop(path, None)
    return state, None
