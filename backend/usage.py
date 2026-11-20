"""按天记录 token 用量。

一天一个文件：`var/usage/2026-11-20.json`，内容形如 `{"1.2.3.4|abc": 12345}`。
跨天自动换文件，不需要清理任务，也不需要数据库。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "var" / "usage"
DEFAULT_LIMIT = 100_000

_lock = threading.Lock()


def limit() -> int:
    """每天每个设备的 token 上限，用 DAILY_TOKEN_LIMIT 改；0 表示不限制。"""
    try:
        return max(0, int(os.environ.get("DAILY_TOKEN_LIMIT") or DEFAULT_LIMIT))
    except ValueError:
        return DEFAULT_LIMIT


def today() -> str:
    return time.strftime("%Y-%m-%d")


def key_of(ip: str, client: str) -> str:
    """IP 和浏览器 id 一起记：换网络的同一浏览器、同 IP 的另一个浏览器，都算不同额度。"""
    ip = (ip or "unknown").strip()
    client = (client or "").strip()[:64]
    return f"{ip}|{client}" if client else ip


def _path() -> Path:
    return STORE / f"{today()}.json"


def _load() -> dict[str, Any]:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def used(key: str) -> int:
    with _lock:
        try:
            return int(_load().get(key) or 0)
        except (TypeError, ValueError):
            return 0


def over(key: str) -> bool:
    cap = limit()
    return cap > 0 and used(key) >= cap


def add(key: str, tokens: int) -> int:
    """记一笔，返回这个 key 今天累计用了多少。"""
    if tokens <= 0:
        return used(key)
    with _lock:
        data = _load()
        try:
            total = int(data.get(key) or 0) + tokens
        except (TypeError, ValueError):
            total = tokens
        data[key] = total
        try:
            STORE.mkdir(parents=True, exist_ok=True)
            path = _path()
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass
        return total
