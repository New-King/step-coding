"""Step Coding 后端。

两条线：
  1. 生成：/api/plan-files、/api/write —— 模型决定写哪个文件、写什么
  2. 工作区：/api/workspace/* —— 打开真实的本地目录，读文件、写文件

打开了工作区之后，/api/write 会把内容真的落到磁盘上；没打开就只回给前端。
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


class PlanIn(BaseModel):
    task: str


class WriteIn(BaseModel):
    task: str
    path: str
    plan: list[str] = Field(default_factory=list)
    files: dict[str, str] = Field(default_factory=dict)


class OpenIn(BaseModel):
    path: str


class SaveIn(BaseModel):
    path: str
    content: str


class DeleteIn(BaseModel):
    path: str


@app.post("/api/plan-files")
def post_plan(body: PlanIn) -> dict[str, Any]:
    """先判断这句话是不是活儿；不是就只回一句话，别开工。"""
    if not body.task.strip():
        raise HTTPException(status_code=400, detail="任务不能为空")
    try:
        return agent.decide(body.task)
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/write")
def post_write(body: WriteIn) -> dict[str, Any]:
    try:
        result = agent.write_file(body.task, body.path, body.files, body.plan or [body.path])
    except agent.AgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # 没有工作区就没有落点，直接拒绝——不然前端演一遍，磁盘上什么都没有
    if ws.root is None:
        raise HTTPException(status_code=409, detail="还没有打开项目，文件没有落点")

    try:
        info = ws.write(result["path"], result["content"])
        result["written"] = True
        result["absolute"] = str(ws.root / result["path"])
        result["created"] = info["created"]
    except WorkspaceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return result


# ------------------------------------------------------------------ 工作区

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
