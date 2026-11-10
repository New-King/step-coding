"""Step Coding —— 讲清一个环节的最小例子。

纯网页版：不碰本地文件、不执行命令、不需要打开项目。
一个接口：POST /api/explain，返回一份教案，前端负责把它演出来。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import explain

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="1.0", description="用最小例子讲清一个环节")


class AskIn(BaseModel):
    question: str


@app.post("/api/explain")
def post_explain(body: AskIn) -> dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="说说你不懂哪个环节")
    try:
        return explain.generate(question)
    except explain.ExplainError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": explain.MODEL, "configured": explain.has_key()}


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
