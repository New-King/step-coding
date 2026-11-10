"""Step Coding 后端。

两条线：
  1. 会话：/api/session、/api/agent/step —— 模型用 function calling 驱动工具
  2. 工作区：/api/workspace/* —— 打开本地目录、按层列目录、读写删移

agent 的每个动作都直接作用在打开的项目上，前端播的是真实发生的事。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agent
from .workspace import WorkspaceError, pick_folder, workspace as ws

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="0.2", description="让人看清 AI 怎么写代码")


class StartIn(BaseModel):
    task: str


class StepIn(BaseModel):
    messages: list[dict[str, Any]]
    round: int = 0


class OpenIn(BaseModel):
    path: str


class DeleteIn(BaseModel):
    path: str


class SaveIn(BaseModel):
    path: str
    content: str


@app.post("/api/intent")
def post_intent(body: StartIn) -> dict[str, Any]:
    if not body.task.strip():
        raise HTTPException(status_code=400, detail="任务不能为空")
    try:
        return agent.decide(body.task)
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/session")
def post_session(body: StartIn) -> dict[str, Any]:
    """新建一次会话，返回初始消息（含系统提示）。"""
    if ws.root is None:
        raise HTTPException(status_code=409, detail="还没有打开项目")
    return {"messages": agent.start(body.task)}


@app.post("/api/agent/step")
def post_step(body: StepIn) -> dict[str, Any]:
    """跑一轮工具调用。前端播完返回的事件后再来问下一轮。"""
    if ws.root is None:
        raise HTTPException(status_code=409, detail="还没有打开项目")
    try:
        return agent.step(body.messages, body.round)
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/workspace")
def get_workspace() -> dict[str, Any]:
    return ws.light()


@app.post("/api/workspace/pick")
def pick_workspace() -> dict[str, Any]:
    """弹系统目录选择框。前端拿不到就回退到手输路径。"""
    return {"path": pick_folder()}


@app.post("/api/workspace/open")
def open_workspace(body: OpenIn) -> dict[str, Any]:
    try:
        return ws.open(body.path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workspace/close")
def close_workspace() -> dict[str, Any]:
    ws.close()
    return ws.snapshot()


@app.get("/api/workspace/list")
def list_workspace_dir(path: str = "") -> dict[str, Any]:
    """只列一层目录；展开某个目录时前端再请求它的下一层。"""
    try:
        return ws.list_dir(path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/workspace/file")
def read_workspace_file(path: str) -> dict[str, Any]:
    try:
        return ws.read(path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workspace/delete")
def delete_workspace_file(body: DeleteIn) -> dict[str, Any]:
    try:
        return ws.delete(body.path)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/workspace/save")
def save_workspace_file(body: SaveIn) -> dict[str, Any]:
    try:
        return ws.write(body.path, body.content)
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": agent.MODEL, "configured": agent.has_key()}


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
