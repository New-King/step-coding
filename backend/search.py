"""联网搜索。两个后端，按环境变量切换：

  SEARCH_PROVIDER=serper   SEARCH_API_KEY=...   （2500 次免费，之后 $1/千次）
  SEARCH_PROVIDER=bocha    SEARCH_API_KEY=...   （国内直连，约 ¥5/千次）

没配 key 就整条链路关掉，agent 也不会用 search 动作。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


class SearchError(RuntimeError):
    pass


def provider() -> str:
    return os.environ.get("SEARCH_PROVIDER", "").strip().lower()


def key() -> str:
    return os.environ.get("SEARCH_API_KEY", "").strip()


def enabled() -> bool:
    return provider() in {"serper", "bocha"} and bool(key())


def _post(url: str, body: dict, headers: dict[str, str]) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SearchError(f"搜索服务返回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SearchError(f"连不上搜索服务：{exc}") from exc


def query(text: str, count: int = 5) -> list[dict[str, Any]]:
    """返回 [{title, url, snippet}]。"""
    if not enabled():
        raise SearchError("没有配置搜索服务")

    if provider() == "serper":
        data = _post(
            "https://google.serper.dev/search",
            {"q": text, "num": count},
            {"X-API-KEY": key()},
        )
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", ""),
            }
            for item in (data.get("organic") or [])[:count]
        ]

    data = _post(
        "https://api.bochaai.com/v1/web-search",
        {"query": text, "count": count, "summary": False},
        {"Authorization": f"Bearer {key()}"},
    )
    pages = ((data.get("data") or {}).get("webPages") or {}).get("value") or []
    return [
        {
            "title": item.get("name", ""),
            "url": item.get("url", ""),
            "snippet": item.get("snippet", ""),
        }
        for item in pages[:count]
    ]


def render(results: list[dict[str, Any]]) -> str:
    if not results:
        return "没有搜到结果。"
    lines = []
    for i, r in enumerate(results, start=1):
        lines.append(f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet'][:220]}")
    return "\n".join(lines)
