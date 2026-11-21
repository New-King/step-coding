"""给模型看的项目上下文。

只放**清单**（路径 + 行数 + 大小），不放正文。
原因：正文一旦放进 system，每写一次文件前缀就变，模型的上下文缓存全部失效，
输入按全价重复计费。正文改成用 look 工具按需读取。

清单里给大小，是因为读不读由模型自己判断：`look()` 只看清单几乎不花 token，
`look("index.html")` 才把整份正文拉进来。大小写在旁边，它才好掂量值不值得读。
"""

from __future__ import annotations


def size(n: int) -> str:
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB"


def manifest(files: dict[str, str]) -> str:
    if not files:
        return "项目是空的，一个文件都没有。"
    lines = ["当前项目（文件名 · 行数 · 大小；要看正文用 look 读单个文件）："]
    for path, body in files.items():
        lines.append(f"  {path}  {len(body.splitlines())} 行 · {size(len(body))}")
    return "\n".join(lines)


def content(files: dict[str, str], paths: list[str] | None = None) -> str:
    """按需读取正文（给 look 工具用）。整份返回，不截断。"""
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
