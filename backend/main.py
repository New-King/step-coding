"""Step Coding 后端。

一次操作 = 一个会话，会话在服务端。客户端每轮只发"这一轮的增量"：

  POST /api/session   建立或恢复会话
  POST /api/step      带上 seq 请求下一个动作（幂等，可安全重试）

返回里只有变化的文件（changed），不再整份来回搬。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, search, session, trace, usage

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Step Coding", version="3.0", description="看清它一步一步把东西做出来")


class SessionIn(BaseModel):
    id: str
    messages: Optional[list[dict[str, Any]]] = None
    files: Optional[dict[str, str]] = None
    seq: int = 0


class StepIn(BaseModel):
    session_id: str
    seq: int
    message: Optional[str] = None
    pending_search: Optional[str] = None


@app.post("/api/session")
def post_session(body: SessionIn) -> dict[str, Any]:
    """建立或恢复会话。带 messages/files 就是恢复（服务端重启后的兜底）。"""
    if not session.valid_id(body.id):
        raise HTTPException(status_code=400, detail="会话 id 不合法")
    sess = session.get(body.id)

    if sess is None:
        # 空项目也是合法现场：只有两个字段都没给才算"无从恢复"
        if body.messages is None and body.files is None:
            raise HTTPException(status_code=404, detail="会话不存在，也没有可恢复的现场")
        sess = session.Session(body.id, body.messages, body.files, body.seq)
        session.put(sess)
        sess.save()

    return {
        "id": sess.id,
        "seq": sess.seq,
        "files": sess.files,
        "messages": sess.history(),
        "last_event": sess.last_event,
        "last_stop": sess.last_stop,
        "restored": True,
    }


def _client_key(request: Request) -> str:
    """反代后面取真实来源：优先 X-Real-IP / X-Forwarded-For，再退到连接地址。"""
    ip = (request.headers.get("x-real-ip") or "").strip()
    if not ip:
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")
        ip = forwarded[0].strip() if forwarded else ""
    if not ip and request.client:
        ip = request.client.host
    return usage.key_of(ip, request.headers.get("x-client-id") or "")


@app.post("/api/step")
def post_step(body: StepIn, request: Request) -> dict[str, Any]:
    if not session.valid_id(body.session_id):
        raise HTTPException(status_code=400, detail="会话 id 不合法")

    key = _client_key(request)
    if usage.over(key):
        raise HTTPException(
            status_code=429,
            detail=f"今天的 token 额度（{usage.limit()}）用完了，明天再试",
        )

    sess = session.get(body.session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="会话不存在，请重新开始")

    # 同一会话串行执行：超时重试不会让同一轮跑两遍
    with sess.step_lock:
        # 幂等：同一轮重复请求（重试/网络抖动）直接回放上次结果，不再执行。
        # 注意：这要求客户端在续做旧会话前先 /api/session 同步 seq，
        # 否则带着新消息用旧 seq 请求会命中这里，消息不会被追加。
        if body.seq < sess.seq:
            return {
                "event": sess.last_event,
                "seq": sess.seq,
                "changed": {},
                "stop": sess.last_stop,
                "replayed": True,
            }
        if body.seq > sess.seq:
            raise HTTPException(status_code=409, detail="状态不同步，请重新加载")

        if body.message:
            sess.messages.append({"role": "user", "content": body.message})
            # 新的一轮从这一步开始计步：步数上限是「一轮最多走几步」，
            # 不是「一个会话总共几步」——按会话算的话第 20 步之后这个会话就不能用了
            sess.turn_start = sess.seq

        before = dict(sess.files)
        started = time.time()

        try:
            result = agent.step(
                sess.messages,
                sess.files,
                sess.seq - sess.turn_start,
                body.pending_search or "",
                sess.observed,
            )
        except agent.AgentError as exc:
            # 失败也要记账、留痕：这一轮同样花了 token，而且要看得出坏在第几步
            tokens = agent.take_tokens()
            usage.add(key, tokens)
            trace.record(
                body.session_id,
                body.seq,
                {"action": "error"},
                {},
                sess.messages,
                int((time.time() - started) * 1000),
                tokens,
                True,
                str(exc),
            )
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        tokens = agent.take_tokens()
        usage.add(key, tokens)

        sess.messages = result["messages"]
        sess.files = result.get("files", sess.files)
        sess.last_event = result["event"]
        sess.last_stop = bool(result.get("stop"))
        sess.seq += 1
        sess.updated_at = time.time()

        session.put(sess)
        sess.save()

        changed = session.diff(before, sess.files)
        trace.record(
            body.session_id,
            body.seq,
            result["event"],
            changed,
            sess.messages,
            int((time.time() - started) * 1000),
            tokens,
            sess.last_stop,
        )

        return {
            "event": result["event"],
            "seq": sess.seq,
            "changed": changed,
            "stop": sess.last_stop,
        }


@app.delete("/api/session/{sid}")
def delete_session(sid: str) -> dict[str, Any]:
    session.drop(sid)
    return {"ok": True}


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
