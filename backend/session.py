"""服务端会话：让循环只传"这一轮的增量"，并且可以安全重试。

之前的做法是每轮把整份对话 + 整份文件发给后端，后端算完再把整份文件退回来。
问题：

- 文件一大，每轮请求就跟着变大（实测 1 个文件 12KB，5 个文件就到几百 KB）
- 网络一抖，这一轮就丢了；想重试又怕重复执行（没有幂等）
- 浏览器是唯一的状态源，服务重启/换标签页就断

现在：

- 会话在服务端（内存 + 落盘），客户端只发 `session_id` 和这一轮的用户消息
- 每轮带 `seq`，服务端只接受"下一轮"；重复的同 seq 请求直接回放上次结果，
  所以客户端可以放心重试
- 写完一轮就把会话落盘，重启后还能接上
"""

from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "var" / "sessions"
MAX_SESSIONS = 40
MAX_MESSAGES = 80


class SessionError(RuntimeError):
    pass


def _trim(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """裁剪历史时别把 tool_calls 和它的 tool 结果拆散，否则模型接口会报错。"""
    if len(messages) <= MAX_MESSAGES:
        return list(messages)

    cut = messages[-MAX_MESSAGES:]
    # 前半段若以 tool 消息开头，说明它的 assistant(tool_calls) 被切掉了
    while cut and cut[0].get("role") == "tool":
        cut = cut[1:]
    # 末尾若是带 tool_calls 的 assistant 却没有对应 tool 结果，也去掉
    while cut and cut[-1].get("tool_calls"):
        cut = cut[:-1]
    return cut


class Session:
    def __init__(
        self,
        sid: str,
        messages: Optional[list[dict[str, str]]] = None,
        files: Optional[dict[str, str]] = None,
        seq: int = 0,
    ) -> None:
        self.id = sid
        self.messages: list[dict[str, str]] = list(messages or [])
        self.files: dict[str, str] = dict(files or {})
        self.seq = seq
        self.last_event: Optional[dict[str, Any]] = None
        self.updated_at = time.time()

    # ---- 落盘 ----

    def dump(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "messages": _trim(self.messages),
            "files": self.files,
            "seq": self.seq,
            "last_event": self.last_event,
            "updated_at": self.updated_at,
        }

    def save(self) -> None:
        try:
            STORE.mkdir(parents=True, exist_ok=True)
            (STORE / f"{self.id}.json").write_text(
                json.dumps(self.dump(), ensure_ascii=False), encoding="utf-8"
            )
        except OSError:
            pass

    @classmethod
    def load(cls, sid: str) -> Optional["Session"]:
        path = STORE / f"{sid}.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            sess = cls(
                data["id"],
                data.get("messages"),
                data.get("files"),
                int(data.get("seq") or 0),
            )
            sess.last_event = data.get("last_event")
            sess.updated_at = float(data.get("updated_at") or time.time())
            return sess
        except (OSError, ValueError, KeyError):
            return None


_lock = threading.Lock()
_sessions: "OrderedDict[str, Session]" = OrderedDict()


def get(sid: str) -> Optional[Session]:
    with _lock:
        sess = _sessions.get(sid)
        if sess:
            _sessions.move_to_end(sid)
            return sess
    sess = Session.load(sid)
    if sess:
        with _lock:
            _sessions[sid] = sess
            _sessions.move_to_end(sid)
    return sess


def put(sess: Session) -> None:
    with _lock:
        _sessions[sess.id] = sess
        _sessions.move_to_end(sess.id)
        while len(_sessions) > MAX_SESSIONS:
            _sessions.popitem(last=False)


def drop(sid: str) -> None:
    with _lock:
        _sessions.pop(sid, None)
    try:
        (STORE / f"{sid}.json").unlink(missing_ok=True)
    except OSError:
        pass


def diff(before: dict[str, str], after: dict[str, str]) -> dict[str, Optional[str]]:
    """只回传变了的部分；删掉的文件用 None 表示。"""
    out: dict[str, Optional[str]] = {}
    for path, body in after.items():
        if before.get(path) != body:
            out[path] = body
    for path in before:
        if path not in after:
            out[path] = None
    return out