from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import main, session, usage


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    """每个用例一个独立的会话目录，绝不碰 var/sessions。

    额度目录也要换走：接口跑一轮就会落一笔 token，而且跨天清理会删旧文件 ——
    这两件事都不该发生在真正的 var/usage 里。
    """
    monkeypatch.setattr(session, "STORE", tmp_path / "sessions")
    monkeypatch.setattr(usage, "STORE", tmp_path / "usage")
    session._sessions.clear()
    yield
    session._sessions.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)