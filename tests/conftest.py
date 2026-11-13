from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import main, session


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    """每个用例一个独立的会话目录，绝不碰 var/sessions。"""
    monkeypatch.setattr(session, "STORE", tmp_path / "sessions")
    session._sessions.clear()
    yield
    session._sessions.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)