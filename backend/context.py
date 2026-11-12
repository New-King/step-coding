"""给模型看的项目上下文。

只放**清单**（路径 + 行数），不放正文。
原因：正文一旦放进 system，每写一次文件前缀就变，模型的上下文缓存全部失效，
输入按全价重复计费。正文改成用 look 工具按需读取。
"""

from __future__ import annotations


def manifest(files: dict[str, str]) -> str:
    if not files:
        return "项目是空的，一个文件都没有。"
    # 不带行数：行数一变 system 就变，前缀缓存又会失效
    lines = ["当前项目（只有文件名；要看内容用 look）："]
    lines.extend(f"  {path}" for path in files)
    return "\n".join(lines)


def content(files: dict[str, str], paths: list[str] | None = None) -> str:
    """按需读取正文（给 look 工具用）。"""
    if not files:
        return "项目是空的。"
    targets = paths if paths else list(files)
    parts = []
    for path in targets:
        body = files.get(path)
        if body is None:
            continue
        parts.append(f"=== {path}（{len(body.splitlines())} 行）===\n{body.rstrip()}")
    return "\n\n".join(parts) if parts else "没有这些文件。"
