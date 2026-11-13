from backend import agent, search
from backend.agent_error import TruncatedError
from tests.helpers import reply


def test_look_missing_file_returns_error_not_whole_project(monkeypatch):
    monkeypatch.setattr(
        agent, "_call", lambda messages: reply({"action": "look", "path": "missing.js"})
    )
    out = agent.step([], {"a.js": "const a = 1;\n"}, 0)
    assert out["event"] == {"action": "look", "path": "missing.js"}
    tool = out["messages"][-1]
    assert tool["role"] == "tool"
    assert "不存在" in tool["content"]
    assert "missing.js" in tool["content"]


def test_look_empty_path_lists_project(monkeypatch):
    monkeypatch.setattr(
        agent, "_call", lambda messages: reply({"action": "look", "path": ""})
    )
    out = agent.step([], {"a.js": "x", "b.css": "y"}, 0)
    assert out["event"]["action"] == "look"
    assert "a.js" in out["messages"][-1]["content"]
    assert "当前项目" in out["messages"][-1]["content"]


def test_search_failure_is_visible_to_client_and_model(monkeypatch):
    def boom(_query):
        raise search.SearchError("没有网络")

    monkeypatch.setattr(agent.search, "query", boom)
    out = agent.step([], {}, 0, pending_search="asyncio gather")
    assert out["event"]["action"] == "search"
    assert out["event"]["error"] == "没有网络"
    assert out["event"]["results"] == []
    assert "搜索失败" in out["messages"][-1]["content"]


def test_truncated_output_gets_one_nudge_retry(monkeypatch):
    calls = []

    def fake(messages):
        calls.append(messages)
        if len(calls) == 1:
            raise TruncatedError("截断")
        return reply({"action": "finish", "text": "写好了"})

    monkeypatch.setattr(agent, "_call", fake)
    out = agent.step([], {}, 0)
    assert out["event"]["action"] == "finish"
    assert len(calls) == 2
    assert calls[1][-1]["content"].startswith("上一次输出被截断了")


def test_repeat_guard_stops_before_calling_model(monkeypatch):
    calls = []

    def fake(messages):
        calls.append(messages)
        return reply({"action": "finish", "text": "不该走到这里"})

    monkeypatch.setattr(agent, "_call", fake)
    messages = []
    for _ in range(8):
        messages.append(
            {
                "role": "assistant",
                "tool_calls": [
                    {"function": {"name": "look", "arguments": '{"path": ""}'}}
                ],
            }
        )
    out = agent.step(messages, {}, 0)
    assert out["event"]["action"] == "finish"
    assert "重复" in out["event"]["text"]
    assert calls == []


def test_claim_missing_file_is_forced_into_a_real_write(monkeypatch):
    fake = iter(
        [
            reply({"action": "say", "text": "我写好了 index.html"}, 1),
            reply(
                {
                    "action": "write",
                    "path": "index.html",
                    "label": "新建页面",
                    "code": "<!doctype html>\n<title>登录</title>\n",
                    "lang": "html",
                    "overwrite": False,
                },
                2,
            ),
        ]
    )
    monkeypatch.setattr(agent, "_call", lambda messages: next(fake))

    out = agent.step([], {}, 0)
    assert out["event"]["action"] == "write"
    assert out["files"]["index.html"].startswith("<!doctype html>")
    assert out["messages"][0]["role"] == "assistant"
    assert out["messages"][1]["role"] == "tool"
    assert out["messages"][2]["role"] == "assistant"
    assert out["messages"][3]["role"] == "tool"


def test_max_rounds_stops(monkeypatch):
    monkeypatch.setattr(
        agent,
        "_call",
        lambda messages: (_ for _ in ()).throw(AssertionError("不应调用模型")),
    )
    out = agent.step([], {}, agent.MAX_ROUNDS)
    assert out["event"]["action"] == "finish"