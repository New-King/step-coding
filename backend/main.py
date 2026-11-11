"""Step Coding 后端。

一个接口驱动整个循环：

  POST /api/step   带着「消息历史 + 当前文件」问下一动作
                   模型一次只回一个：think / look / plan / ask / write / edit / delete / finish

由前端逐轮驱动，所以每一步都看得见，中途也停得住。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, search

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="2.0", description="看清它一步一步把东西做出来")


class StepIn(BaseModel):
    messages: list[dict[str, str]]
    files: dict[str, str] = {}
    round: int = 0


@app.post("/api/step")
def post_step(body: StepIn) -> dict[str, Any]:
    try:
        return agent.step(body.messages, body.files, body.round)
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": agent.MODEL,
        "configured": agent.has_key(),
        "search": search.provider() if search.enabled() else None,
    }


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(
            WEB_DIST / "index.html",
            headers={"Cache-Control": "no-store, must-revalidate"},
        )
