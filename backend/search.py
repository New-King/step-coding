"""联网搜索。

默认用 DeepSeek 自研搜索（Search / Fetch API）：
  同一个 DEEPSEEK_API_KEY，不用再注册别家
  ¥5 / 1000 次成功请求，失败和无结果不计费
  POST https://api.deepseek.com/v1/tools/search

也留了 serper / bocha 两个后端，按 SEARCH_PROVIDER 切换。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


_load_env()


class SearchError(RuntimeError):
    pass


def provider() -> str:
    name = os.environ.get("SEARCH_PROVIDER", "").strip().lower()
    return name or "deepseek"


def key() -> str:
    if provider() == "deepseek":
        return os.environ.get("DEEPSEEK_API_KEY", "").strip()
    return os.environ.get("SEARCH_API_KEY", "").strip()


def enabled() -> bool:
    return provider() in {"deepseek", "serper", "bocha"} and bool(key())


def _post(url: str, body: dict, headers: dict[str, str]) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")[:160]
        raise SearchError(f"搜索返回 HTTP {exc.code} {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SearchError(f"连不上搜索服务：{exc}") from exc


def query(text: str, count: int = 5, need_content: bool = False) -> list[dict[str, Any]]:
    """返回 [{title, url, snippet, content?}]。"""
    if not enabled():
        raise SearchError("没有配置搜索服务")

    name = provider()

    if name == "deepseek":
        base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
        data = _post(
            f"{base}/tools/search",
            {"query": text, "count": count, "need_content": need_content},
            {"Authorization": f"Bearer {key()}"},
        )
        return [
            {
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": item.get("snippet") or item.get("summary") or "",
                "site": item.get("site_name") or "",
                "content": item.get("content", ""),
            }
            for item in (data.get("results") or [])[:count]
        ]

    if name == "serper":
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


def fetch(url: str) -> str:
    """抓一个网页的正文（Markdown）。只有 DeepSeek 后端支持。"""
    if provider() != "deepseek":
        raise SearchError("当前搜索后端不支持 fetch")
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    data = _post(f"{base}/tools/fetch", {"url": url}, {"Authorization": f"Bearer {key()}"})
    return str(data.get("content") or "")[:6000]


def render(results: list[dict[str, Any]]) -> str:
    if not results:
        return "没有搜到结果。"
    lines = []
    for i, r in enumerate(results, start=1):
        site = f" [{r['site']}]" if r.get("site") else ""
        title = r["title"] or r["url"]
        lines.append(f"{i}. {title}{site}\n   {r['url']}\n   {r['snippet'][:240]}")
    return "\n".join(lines)