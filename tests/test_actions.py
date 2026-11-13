import pytest

from backend.actions import normalize
from backend.agent_error import AgentError


def test_write_requires_path_and_content():
    with pytest.raises(AgentError):
        normalize({"action": "write", "path": "", "content": "x"})
    with pytest.raises(AgentError):
        normalize({"action": "write", "path": "a.js", "content": "  "})


def test_write_content_gets_trailing_newline_and_aliases():
    out = normalize(
        {"action": "write", "path": "/a.js", "code": "const a = 1;", "lang": "JS"}
    )
    assert out["path"] == "a.js"
    assert out["code"] == "const a = 1;\n"
    assert out["lang"] == "js"
    assert out["overwrite"] is False


def test_edit_requires_find():
    with pytest.raises(AgentError):
        normalize({"action": "edit", "path": "a.js", "find": "", "replace": "x"})
    out = normalize(
        {"action": "edit", "path": "a.js", "find": "old", "replace": "new"}
    )
    assert out == {
        "action": "edit",
        "path": "a.js",
        "label": "改一处",
        "find": "old",
        "replace": "new",
    }


def test_ask_normalizes_options_and_caps_questions():
    out = normalize(
        {
            "action": "ask",
            "questions": [
                {"question": "用什么？", "options": ["A", {"label": "B"}, ""]},
                {"question": "放哪？", "options": []},
                {"question": ""},
            ],
        }
    )
    assert out["action"] == "ask"
    assert out["questions"] == [
        {"question": "用什么？", "options": ["A", "B"]},
        {"question": "放哪？", "options": []},
    ]


def test_decline_keeps_at_most_three_suggestions():
    out = normalize(
        {
            "action": "decline",
            "text": "这个查不了",
            "suggestions": ["a", "b", "c", "d"],
        }
    )
    assert out["suggestions"] == ["a", "b", "c"]


def test_unknown_action_is_rejected():
    with pytest.raises(AgentError):
        normalize({"action": "teleport"})
    with pytest.raises(AgentError):
        normalize({})