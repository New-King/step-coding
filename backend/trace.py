"""每一步的执行记录。

一行一步，写到 `var/traces/<session_id>.jsonl`。定位「从第几步开始坏」只看这里。

只记定位需要的东西：
- 动作名 + 参数（长文本截断并标出原长度）
- 改了哪些文件（sha256 前 12 位 + 是否删除）
- 历史规模与 hash（不存完整 prompt：每次都是几十条历史，体积大且可直接重算）
- 耗时 / token / 是否收尾 / 错误

**不存文件全文**：原文在 `var/sessions/<id>.json` 里已经有，重复存只会让磁盘膨胀。

这里写进去的东西只给人看，永远不会回灌给模型。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "var" / "traces"
SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# 单个字段最多留这么多字：write 的正文、say 的回复都按这个截
CLIP = 2000


def _clip(value: Any, limit: int = CLIP) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return f"{value[:limit]}…（截断，原 {len(value)} 字）"
    if isinstance(value, dict):
        return {k: _clip(v, limit) for k, v in value.items()}
    if isinstance(value, list):
        return [_clip(v, limit) for v in value[:50]]
    return value


def digest(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def record(
    session_id: str,
    seq: int,
    event: dict[str, Any],
    changed: dict[str, str | None],
    messages: list[dict[str, Any]],
    ms: int,
    tokens: int,
    stop: bool,
    error: str = "",
) -> None:
    """追加一条记录。写盘失败不影响主流程。"""
    if not SAFE.match(session_id or ""):
        return
    row = {
        "t": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "session": session_id,
        "seq": seq,
        "action": event.get("action"),
        "event": _clip(event),
        "changed": {p: (digest(v) if v is not None else None) for p, v in (changed or {}).items()},
        "history": {
            "rows": len(messages),
            "hash": digest(json.dumps(messages, ensure_ascii=False)),
        },
        "ms": ms,
        "tokens": tokens,
        "stop": bool(stop),
        "error": error,
    }
    try:
        STORE.mkdir(parents=True, exist_ok=True)
        with (STORE / f"{session_id}.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass
