"""工作区：让 agent 在一个真实的本地目录里干活。

第一版只做三件事：列目录、读文件、写文件。
命令执行、文件监听、git 都还没有。

安全边界：所有路径都必须落在 root 之内，`..` 直接拒绝。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# 目录太大、或者纯属噪音，列目录时跳过
IGNORE = {
    "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build",
    ".next", ".nuxt", "target", "vendor", ".idea", ".vscode", ".DS_Store",
    ".pnpm-store", "coverage", ".cache", ".turbo",
}

MAX_FILES = 3000
MAX_DEPTH = 6
MAX_READ = 200_000
MAX_ENTRIES = 500


class WorkspaceError(RuntimeError):
    pass


class Workspace:
    def __init__(self) -> None:
        self.root: Path | None = None

    # ------------------------------------------------------------ 打开

    def open(self, path: str) -> dict[str, Any]:
        target = Path(os.path.expanduser(path)).resolve()
        if not target.exists():
            raise WorkspaceError(f"目录不存在：{target}")
        if not target.is_dir():
            raise WorkspaceError(f"不是目录：{target}")

        self.root = target
        return self.light()

    def close(self) -> None:
        self.root = None

    # ------------------------------------------------------------ 安全

    def resolve(self, rel: str) -> Path:
        if self.root is None:
            raise WorkspaceError("还没有打开项目")
        clean = rel.lstrip("/").replace("\\", "/")
        target = (self.root / clean).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            raise WorkspaceError(f"路径越界：{rel}") from None
        return target

    # ------------------------------------------------------------ 读

    def light(self) -> dict[str, Any]:
        """只报项目本身，不遍历内容——树由 list_dir 按需一层层取。"""
        if self.root is None:
            return {"root": None, "name": None}
        return {"root": str(self.root), "name": self.root.name}

    def snapshot(self) -> dict[str, Any]:
        if self.root is None:
            return {"root": None, "files": [], "total": 0, "truncated": False}

        files: list[dict[str, Any]] = []
        state = {"truncated": False}

        def walk(directory: Path, depth: int) -> None:
            if state["truncated"] or depth > MAX_DEPTH:
                return
            try:
                entries = sorted(
                    directory.iterdir(), key=lambda e: (e.is_file(), e.name.lower())
                )
            except OSError:
                return

            for entry in entries:
                name = entry.name
                if name.startswith(".") or name in IGNORE:
                    continue
                rel = entry.relative_to(self.root).as_posix()

                if entry.is_dir():
                    files.append({"path": rel, "name": name, "depth": depth, "type": "dir"})
                    if len(files) >= MAX_FILES:
                        state["truncated"] = True
                        return
                    walk(entry, depth + 1)
                else:
                    try:
                        size = entry.stat().st_size
                    except OSError:
                        size = 0
                    files.append(
                        {
                            "path": rel,
                            "name": name,
                            "depth": depth,
                            "type": "file",
                            "size": size,
                        }
                    )
                    if len(files) >= MAX_FILES:
                        state["truncated"] = True
                        return

        walk(self.root, 0)

        return {
            "root": str(self.root),
            "name": self.root.name,
            "files": files,
            "total": len(files),
            "truncated": state["truncated"],
        }

    def list_dir(self, rel: str = "") -> dict[str, Any]:
        """只列一层。前端展开目录时再问下一层，不用一次把整棵树搬到内存。"""
        if self.root is None:
            raise WorkspaceError("还没有打开项目")

        target = self.resolve(rel) if rel else self.root
        if not target.is_dir():
            raise WorkspaceError(f"不是目录：{rel}")

        try:
            items = sorted(target.iterdir(), key=lambda e: (e.is_file(), e.name.lower()))
        except OSError as exc:
            raise WorkspaceError(f"读不了目录：{rel}") from exc

        entries: list[dict[str, Any]] = []
        for entry in items:
            name = entry.name
            if name.startswith(".") or name in IGNORE:
                continue
            child = entry.relative_to(self.root).as_posix()
            if entry.is_dir():
                entries.append({"path": child, "name": name, "type": "dir"})
            elif entry.is_file():
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = 0
                entries.append({"path": child, "name": name, "type": "file", "size": size})

        truncated = len(entries) > MAX_ENTRIES
        return {"path": rel, "entries": entries[:MAX_ENTRIES], "truncated": truncated}

    def mkdir(self, rel: str) -> dict[str, Any]:
        path = self.resolve(rel)
        if path.exists():
            raise WorkspaceError(f"已存在：{rel}")
        path.mkdir(parents=True)
        return {"path": rel, "created": True}

    def move(self, src: str, dst: str) -> dict[str, Any]:
        origin = self.resolve(src)
        target = self.resolve(dst)
        if not origin.exists():
            raise WorkspaceError(f"不存在：{src}")
        if target.exists():
            raise WorkspaceError(f"目标已存在：{dst}")
        target.parent.mkdir(parents=True, exist_ok=True)
        origin.rename(target)
        return {"from": src, "to": dst, "moved": True}

    def read(self, rel: str) -> dict[str, Any]:
        path = self.resolve(rel)
        if not path.exists() or not path.is_file():
            raise WorkspaceError(f"文件不存在：{rel}")
        if path.stat().st_size > MAX_READ:
            raise WorkspaceError(f"文件太大（>{MAX_READ // 1000}KB），先不支持")
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise WorkspaceError(f"不是文本文件：{rel}") from None
        return {"path": rel, "content": text, "size": len(text)}

    # ------------------------------------------------------------ 删

    def delete(self, rel: str) -> dict[str, Any]:
        path = self.resolve(rel)
        if path == self.root:
            raise WorkspaceError("不能删除工作区根目录")
        if not path.exists():
            raise WorkspaceError(f"文件不存在：{rel}")
        if path.is_dir():
            if any(path.iterdir()):
                raise WorkspaceError(f"目录非空，先删里面的文件：{rel}")
            path.rmdir()
        else:
            path.unlink()
        return {"path": rel, "deleted": True}

    # ------------------------------------------------------------ 写

    def write(self, rel: str, content: str) -> dict[str, Any]:
        path = self.resolve(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        path.write_text(content, encoding="utf-8")
        return {"path": rel, "created": not existed, "bytes": len(content)}


workspace = Workspace()


def pick_folder(prompt: str = "选择一个项目文件夹") -> str | None:
    """弹出系统目录选择框（仅 macOS）。取消或不可用时返回 None。"""
    import subprocess
    import sys

    if sys.platform != "darwin":
        return None

    script = f'POSIX path of (choose folder with prompt "{prompt}")'
    try:
        out = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if out.returncode != 0:
        return None  # 用户点了取消

    path = (out.stdout or "").strip()
    return path or None
