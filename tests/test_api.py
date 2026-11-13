from __future__ import annotations

import json
import threading
import time

from backend import agent, main, session
from tests.helpers import reply, scripted

SID = "s-test"


def open_session(client, sid: str = SID):
    res = client.post("/api/session", json={"id": sid, "messages": [], "files": {}, "seq": 0})
    assert res.status_code == 200, res.text
    return res.json()


def step(client, seq: int, message: str | None = None, sid: str = SID):
    body = {"session_id": sid, "seq": seq}
    if message is not None:
        body["message"] = message
    return client.post("/api/step", json=body)


def user_texts(messages):
    return [m.get("content") for m in messages if m.get("role") == "user"]


def test_full_scripted_flow_and_session_restore(client, monkeypatch):
    open_session(client)
    actions = [
        {"action": "think", "text": "先看看要做几个文件"},
        {"action": "plan", "steps": ["HTML", "CSS"]},
        {
            "action": "write",
            "path": "index.html",
            "label": "写结构",
            "code": "<!doctype html>\n<link rel=\"stylesheet\" href=\"style.css\">\n",
            "lang": "html",
            "overwrite": False,
        },
        {
            "action": "write",
            "path": "style.css",
            "label": "写样式",
            "code": "body { margin: 0; }\n",
            "lang": "css",
            "overwrite": False,
        },
        {"action": "finish", "text": "写好了"},
    ]
    fake = scripted(actions)
    monkeypatch.setattr(agent, "_call", fake)

    seq = 0
    seen = []
    changed = []
    while True:
        res = step(client, seq, "写个登录页" if seq == 0 else None)
        assert res.status_code == 200, res.text
        body = res.json()
        seen.append(body["event"]["action"])
        changed.append(set(body["changed"]))
        seq = body["seq"]
        if body["stop"]:
            break
    assert seen == ["think", "plan", "write", "write", "finish"]
    assert seq == 5
    assert changed[0] == set()
    assert changed[2] == {"index.html"}
    assert changed[3] == {"style.css"}
    assert fake.remaining() == 0  # 没有多要一轮

    # 历史恢复：同一个 id 能拿回 seq / messages / files
    restored = client.post("/api/session", json={"id": SID}).json()
    assert restored["seq"] == 5
    assert set(restored["files"]) == {"index.html", "style.css"}
    assert user_texts(restored["messages"]) == ["写个登录页"]
    assert restored["last_event"]["action"] == "finish"
    assert restored["last_stop"] is True


def test_stale_seq_replays_and_history_sync_prevents_lost_message(client, monkeypatch):
    open_session(client)
    monkeypatch.setattr(
        agent, "_call", scripted([{"action": "finish", "text": "好了"}])
    )
    first = step(client, 0, "第一句").json()
    assert first["stop"] is True and first["seq"] == 1

    # 旧客户端/没同步 seq：带新消息的旧 seq 请求命中回放，消息不会被追加
    stale = step(client, 0, "第二句").json()
    assert stale["replayed"] is True
    assert stale["seq"] == 1
    assert stale["stop"] is True  # 回放也要带回 stop
    synced = client.post("/api/session", json={"id": SID}).json()
    assert "第二句" not in json.dumps(synced["messages"], ensure_ascii=False)

    # 修复后的前端：先同步 seq，再发消息
    monkeypatch.setattr(
        agent, "_call", scripted([{"action": "finish", "text": "接着说"}])
    )
    res = step(client, synced["seq"], "第二句")
    assert res.status_code == 200
    assert not res.json().get("replayed")
    after = client.post("/api/session", json={"id": SID}).json()
    assert user_texts(after["messages"]) == ["第一句", "第二句"]


def test_ask_replay_keeps_stop(client, monkeypatch):
    open_session(client, "s-ask")
    monkeypatch.setattr(
        agent,
        "_call",
        scripted(
            [
                {
                    "action": "ask",
                    "questions": [{"question": "要后端吗？", "options": ["要", "不要"]}],
                }
            ]
        ),
    )
    first = step(client, 0, "做个页面", sid="s-ask").json()
    assert first["stop"] is True
    replay = step(client, 0, sid="s-ask").json()
    assert replay["replayed"] is True
    assert replay["stop"] is True
    assert replay["event"]["action"] == "ask"


def test_concurrent_same_seq_runs_once(client, monkeypatch):
    sid = "s-lock"
    open_session(client, sid)
    calls = {"n": 0}

    def slow(messages):
        calls["n"] += 1
        time.sleep(0.15)
        return reply({"action": "finish", "text": "好了"}, calls["n"])

    monkeypatch.setattr(agent, "_call", slow)

    barrier = threading.Barrier(2)
    results = []

    def worker():
        barrier.wait()
        results.append(main.post_step(main.StepIn(session_id=sid, seq=0, message="hi")))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert calls["n"] == 1
    assert sorted(r["seq"] for r in results) == [1, 1]
    assert any(r.get("replayed") for r in results)


def test_invalid_session_id_is_rejected(client, tmp_path):
    res = client.post(
        "/api/session", json={"id": "../evil", "messages": [], "files": {}, "seq": 0}
    )
    assert res.status_code == 400
    res = client.post("/api/step", json={"session_id": "../evil", "seq": 0})
    assert res.status_code == 400
    assert not (tmp_path / "evil.json").exists()


def test_missing_session_can_be_rebuilt_from_local_history(client, monkeypatch):
    res = client.post("/api/session", json={"id": "s-old"})
    assert res.status_code == 404

    rebuilt = client.post(
        "/api/session",
        json={"id": "s-old", "messages": [], "files": {"a.js": "let a = 1;\n"}, "seq": 3},
    )
    assert rebuilt.status_code == 200
    assert rebuilt.json()["seq"] == 3
    assert rebuilt.json()["files"] == {"a.js": "let a = 1;\n"}

    monkeypatch.setattr(
        agent, "_call", scripted([{"action": "finish", "text": "接着说"}])
    )
    res = step(client, 3, "继续", sid="s-old")
    assert res.status_code == 200
    assert res.json()["seq"] == 4


def test_edit_mismatch_returns_error_not_crash(client, monkeypatch):
    open_session(client, "s-edit")
    monkeypatch.setattr(
        agent,
        "_call",
        scripted(
            [
                {"action": "write", "path": "a.js", "code": "let a = 1;\n"},
                {"action": "look", "path": "a.js"},
                {
                    "action": "edit",
                    "path": "a.js",
                    "find": "let b = 2;",
                    "replace": "let b = 3;",
                },
            ]
        ),
    )
    step(client, 0, "写 a.js", sid="s-edit").json()
    step(client, 1, sid="s-edit").json()
    body = step(client, 2, sid="s-edit").json()
    assert body["event"]["action"] == "error"
    assert "找不到" in body["event"]["text"]
    assert body["changed"] == {}
    assert session.get("s-edit").files["a.js"] == "let a = 1;\n"