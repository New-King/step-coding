import json

from backend import session
from backend.session import Session, _trim, diff, valid_id


def test_valid_id_rejects_path_traversal():
    assert valid_id("s-1794")
    assert valid_id("abc_DEF-123")
    assert not valid_id("")
    assert not valid_id("../evil")
    assert not valid_id("a/b")
    assert not valid_id("x" * 65)


def test_diff_only_returns_changed_and_deleted():
    before = {"a.js": "1", "b.js": "2"}
    after = {"a.js": "1", "b.js": "3", "c.js": "4"}
    assert diff(before, after) == {"b.js": "3", "c.js": "4"}


def test_trim_does_not_split_tool_calls_from_results():
    messages = [{"role": "user", "content": "start"}]
    messages.append(
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "function": {"name": "think", "arguments": "{}"}}],
        }
    )
    messages.append({"role": "tool", "tool_call_id": "c1", "content": "{}"})
    while len(messages) < 82:
        messages.append({"role": "user", "content": f"m{len(messages)}"})

    cut = _trim(messages)
    assert len(cut) <= 80
    assert cut[0]["role"] != "tool"
    assert not cut[-1].get("tool_calls")


def test_trim_drops_dangling_assistant_tool_call_at_end():
    messages = [{"role": "user", "content": f"m{i}"} for i in range(80)]
    messages.append(
        {
            "role": "assistant",
            "tool_calls": [{"id": "c1", "function": {"name": "think", "arguments": "{}"}}],
        }
    )
    cut = _trim(messages)
    assert len(cut) <= 80
    assert not cut[-1].get("tool_calls")


def test_save_is_atomic_and_round_trips(tmp_path, monkeypatch):
    monkeypatch.setattr(session, "STORE", tmp_path / "sessions")
    sess = Session("s-test", [{"role": "user", "content": "hi"}], {"a.js": "1"}, 3)
    sess.last_event = {"action": "write", "path": "a.js"}
    sess.last_stop = True
    sess.observed = {"a.js"}
    sess.save()

    assert not (tmp_path / "sessions" / "s-test.json.tmp").exists()
    loaded = Session.load("s-test")
    assert loaded is not None
    assert loaded.seq == 3
    assert loaded.files == {"a.js": "1"}
    assert loaded.last_stop is True
    assert loaded.observed == {"a.js"}
    assert loaded.history()[0]["content"] == "hi"


def test_load_infers_last_stop_for_legacy_file(tmp_path, monkeypatch):
    monkeypatch.setattr(session, "STORE", tmp_path / "sessions")
    (tmp_path / "sessions").mkdir()
    legacy = {
        "id": "s-old",
        "messages": [],
        "files": {},
        "seq": 2,
        "last_event": {"action": "finish", "text": "好了"},
    }
    (tmp_path / "sessions" / "s-old.json").write_text(
        json.dumps(legacy, ensure_ascii=False), encoding="utf-8"
    )
    loaded = Session.load("s-old")
    assert loaded is not None
    assert loaded.last_stop is True


def test_load_ignores_unsafe_id(tmp_path, monkeypatch):
    monkeypatch.setattr(session, "STORE", tmp_path / "sessions")
    (tmp_path / "sessions").mkdir()
    evil = tmp_path / "evil.json"
    evil.write_text(json.dumps({"id": "../evil"}), encoding="utf-8")
    assert Session.load("../evil") is None