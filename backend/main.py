"""Step Coding 后端。

主接口是 `/api/step`：前端播完一步，带着当前文件状态来问下一步。

为什么是"播放器驱动后端"而不是流式推送：
  - 播完一步才知道文件真实长什么样，下一步必须基于它
  - 所以循环的控制权在前端，后端只负责决策

`/api/plan` 保留了一个固定回放，用来在没有 key 时也能演示界面。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agent

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="0.2", description="让人看清 AI 怎么写代码")


class PlanIn(BaseModel):
    task: str


class WriteIn(BaseModel):
    task: str
    path: str
    plan: list[str] = Field(default_factory=list)
    files: dict[str, str] = Field(default_factory=dict)


@app.post("/api/plan-files")
def post_plan(body: PlanIn) -> dict[str, Any]:
    if not body.task.strip():
        raise HTTPException(status_code=400, detail="任务不能为空")
    try:
        return {"files": agent.plan_files(body.task)}
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/write")
def post_write(body: WriteIn) -> dict[str, Any]:
    try:
        return agent.write_file(body.task, body.path, body.files, body.plan or [body.path])
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": agent.MODEL, "configured": agent.has_key()}


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
