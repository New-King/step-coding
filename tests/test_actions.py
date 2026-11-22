import pytest

from backend.actions import SAY_CHARS, normalize
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

def test_ask_accepts_plain_string_questions():
    """模型常直接把 questions 写成字符串数组，不能当 dict 用（会 AttributeError → 500）。"""
    out = normalize({"action": "ask", "questions": ["要不要后端？", {"question": "几个页面", "options": ["一个", "多个"]}]})
    assert [q["question"] for q in out["questions"]] == ["要不要后端？", "几个页面"]
    assert out["questions"][0]["options"] == []
    assert out["questions"][1]["options"] == ["一个", "多个"]


def test_say_keeps_code_block_over_200_chars():
    """回复里直接贴代码是正常用法：200 字的老上限会把它从中间截断（实测断在 `quickSort(a, p + 1, hi`）。"""
    code = "```ts\n" + "\n".join(f"const v{i} = {i};" for i in range(30)) + "\n```"
    out = normalize({"action": "say", "text": code})
    assert out["text"] == code
    assert out["text"].endswith("```")


def test_finish_keeps_full_summary():
    """收尾那句是正文，不能按一行摘要切成半句（线上「…只对小数做收敛。现」）。"""
    text = "又查出一处：toPrecision 会把大整数截断。已改为整数直接返回，只对小数做收敛。现在两份文件逻辑和断言一致。"
    out = normalize({"action": "finish", "text": text})
    assert out["text"] == text


def test_overlong_text_gets_marked_not_silently_cut():
    """真超过兜底上限时留省略号，别让人读到半句话还不知道断了。"""
    text = "字" * (SAY_CHARS + 50)
    for action in ("say", "finish", "decline"):
        out = normalize({"action": action, "text": text})
        assert out["text"].endswith("…")
        assert len(out["text"]) <= SAY_CHARS + 1
