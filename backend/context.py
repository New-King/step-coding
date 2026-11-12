"""给模型看的项目上下文：文件清单 + 需要的正文。"""

from __future__ import annotations

from typing import Optional


def tree(files: dict[str, str]) -> str:
    if not files:
        return "项目是空的，一个文件都没有。"
    lines = ["项目现有文件："]
    for path, body in files.items():
        lines.append(f"  {path}（{len(body.splitlines())} 行）")
    return "\n".join(lines)


def context(files: dict[str, str], focus: str | None = None) -> str:
    if not files:
        return "项目是空的。"
    parts = [tree(files)]
    targets = [focus] if focus else list(files)
    for path in targets:
        body = files.get(path)
        if body is None:
            continue
        parts.append(f"\n=== {path} ===\n{body.rstrip()}")
    return "\n".join(parts)


