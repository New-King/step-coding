"""额度在接口层的行为：超了就不调模型，回一句统一的文案。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import agent, main, usage


@pytest.fixture(autouse=True)
def usage_store(tmp_path, monkeypatch):
    """额度文件别落在真的 var/usage 里。"""
    monkeypatch.setattr(usage, "STORE", tmp_path / "usage")
    return tmp_path


def req(client_id: str = "t1"):
    """直接调 post_step 时用的最小请求替身：只用到 headers 和 client。"""
    return SimpleNamespace(
        headers={"x-client-id": client_id},
        client=SimpleNamespace(host="127.0.0.1"),
    )


def no_llm(_messages):
    raise AssertionError("额度已经超了，不该再去调模型")


def test_device_budget_blocks_before_calling_model(monkeypatch):
    monkeypatch.setenv("DAILY_TOKEN_LIMIT", "10")
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "0")  # 全站不限，只考单设备
    monkeypatch.setattr(agent, "_call", no_llm)
    usage.add(usage.key_of("127.0.0.1", "t1"), 10)

    with pytest.raises(HTTPException) as err:
        main.post_step(main.StepIn(session_id="s-b1", seq=0, message="hi"), req())

    assert err.value.status_code == 429
    assert err.value.detail == main.OUT_OF_BUDGET


def test_total_budget_blocks_a_device_that_used_nothing(monkeypatch):
    monkeypatch.setenv("DAILY_TOKEN_LIMIT", "0")  # 单人不限
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "100")
    monkeypatch.setattr(agent, "_call", no_llm)
    # 别的设备把全站预算吃光了
    usage.add(usage.key_of("2.2.2.2", "someone"), 100)

    with pytest.raises(HTTPException) as err:
        main.post_step(main.StepIn(session_id="s-b2", seq=0, message="hi"), req())

    assert err.value.status_code == 429
    assert err.value.detail == main.OUT_OF_BUDGET


def test_usage_endpoint_reports_used_and_limit(client, monkeypatch):
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "12345")
    usage.add(usage.key_of("127.0.0.1", "t1"), 234)

    assert client.get("/api/usage").json() == {"used": 234, "limit": 12_345}
