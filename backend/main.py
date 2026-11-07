"""Step Coding 的后端。

现在只做两件事：
  1. 把一份"步骤计划"交给前端（先是一段固定脚本，之后换成真的 agent loop）
  2. 托管前端构建产物

真正的 agent 进来之后，`/api/plan` 会变成 `/api/next`——
前端播放完一步，再问下一步。接口形状已经按那个方向留好了。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import demo

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="0.1", description="让人看清 AI 怎么写代码")


@app.get("/api/plan")
def get_plan() -> dict[str, Any]:
    """一次完整的写作过程：步骤序列 + 最终文件。"""
    steps = demo.build_steps()
    return {
        "task": "做一个贪吃蛇",
        "steps": steps,
        "files": demo.FILES,
        "stats": {
            "files": len(demo.FILES),
            "steps": len(steps),
            "lines": sum(text.count("\n") for text in demo.FILES.values()),
        },
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
