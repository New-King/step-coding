from backend import agent, search
from backend.agent_error import TruncatedError
from tests.helpers import reply, scripted


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


def test_inline_style_in_html_is_allowed(monkeypatch):
    # 单文件是合法需求：用户要「双击就能打开」就允许内联，文件结构不归我们决定
    code = '<!doctype html>\n<style>\nbody { margin: 0; }\n</style>\n<h1>hi</h1>\n'
    monkeypatch.setattr(
        agent,
        "_call",
        lambda messages: reply(
            {
                "action": "write",
                "path": "index.html",
                "label": "新建页面",
                "code": code,
                "lang": "html",
                "overwrite": False,
            }
        ),
    )
    out = agent.step([], {}, 0)
    assert out["event"]["action"] == "write"
    assert out["files"]["index.html"] == code


def test_split_html_gets_no_nudge(monkeypatch):
    code = (
        '<!doctype html>\n<link rel="stylesheet" href="style.css">\n'
        '<h1>hi</h1>\n<script src="app.js"></script>\n'
    )
    monkeypatch.setattr(
        agent,
        "_call",
        lambda messages: reply(
            {
                "action": "write",
                "path": "index.html",
                "label": "新建页面",
                "code": code,
                "lang": "html",
                "overwrite": False,
            }
        ),
    )
    out = agent.step([], {}, 0)
    assert out["messages"][-1]["role"] == "tool"


def test_look_manifest_shows_size_so_model_can_skip():
    from backend.context import manifest

    text = manifest({"index.html": "<h1>hi</h1>\n" * 100, "app.js": "let a = 1;\n"})
    assert "100 行 · 1.2 KB" in text
    assert "app.js  1 行 · 11 B" in text


def test_max_rounds_stops(monkeypatch):
    monkeypatch.setattr(
        agent,
        "_call",
        lambda messages: (_ for _ in ()).throw(AssertionError("不应调用模型")),
    )
    out = agent.step([], {}, agent.MAX_ROUNDS)
    assert out["event"]["action"] == "finish"

def test_long_say_gets_pushed_into_a_file(monkeypatch):
    """对话只留结论：讲了 240 字以上，退回让它写成文件，写成了就直接落盘。"""
    long_text = "原理讲一大段。" * 40  # 280 字
    calls = scripted([
        {"action": "say", "text": long_text},
        {"action": "write", "path": "notes.md", "code": "# 原理\n\n解释正文"},
    ])
    monkeypatch.setattr(agent, "_call", calls)

    out = agent.step([], {}, 0)

    assert out["event"]["action"] == "write"
    assert out["files"]["notes.md"] == "# 原理\n\n解释正文"
    assert calls.calls["n"] == 2


def test_long_say_falls_back_to_the_short_rewrite(monkeypatch):
    """退回后仍然只说话：用它自己收短的那句，别把结论丢掉。"""
    calls = scripted([
        {"action": "say", "text": "啰嗦" * 150},
        {"action": "say", "text": "三条都跑通了，看 app.js。"},
    ])
    monkeypatch.setattr(agent, "_call", calls)

    out = agent.step([], {}, 0)

    assert out["event"] == {"action": "say", "text": "三条都跑通了，看 app.js。"}
    assert out["stop"] is True


def test_short_say_passes_through(monkeypatch):
    """一句话结论不该被拦。"""
    monkeypatch.setattr(
        agent, "_call", lambda messages: reply({"action": "say", "text": "改好了，看 app.js。"})
    )

    out = agent.step([], {"app.js": "let a = 1;\n"}, 0)

    assert out["event"]["text"] == "改好了，看 app.js。"


def _valid_tool_pairs(messages):
    """接口的硬要求：tool 必须紧跟 assistant(tool_calls)，且每个 id 都有回复。"""
    pending = set()
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            assert not pending, "上一条调用还没回完就来了新调用"
            pending = {c.get("id") for c in m["tool_calls"]}
        elif m.get("role") == "tool":
            assert m.get("tool_call_id") in pending, "tool 没有对应的 tool_calls"
            pending.discard(m.get("tool_call_id"))
        else:
            assert not pending, "调用没回完就插了别的消息"
            pending = set()
    assert not pending, "最后一条调用没有 tool 回复"


def test_recent_never_splits_tool_pairs():
    """裁剪窗口正好切在 tool 上时，不能拼出「user, tool, …」这种 400 组合。"""
    messages = [{"role": "user", "content": "开始"}]
    for i in range(30):
        messages.append({
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": f"c{i}", "function": {"name": "look", "arguments": "{}"}}],
        })
        messages.append({"role": "tool", "tool_call_id": f"c{i}", "content": "{}"})
        if i % 5 == 4:
            messages.append({"role": "user", "content": f"第{i}轮"})

    out = agent._recent(messages)

    assert len(out) < len(messages)
    _valid_tool_pairs(out)


def test_recent_drops_unanswered_tool_call():
    """最后一条 assistant 的调用没有 tool 回复：整组丢掉，别让接口 400。"""
    messages = [{"role": "user", "content": "开始"}] + [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": f"c{i}", "function": {"name": "look", "arguments": "{}"}}],
        }
        for i in range(3)
    ]  # 三条调用全都没回

    out = agent._recent(messages)

    assert out == [{"role": "user", "content": "开始"}]


def test_recent_keeps_complete_pairs():
    """成对的调用回复要原样留着。"""
    messages = [
        {"role": "user", "content": "开始"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c0", "function": {"name": "look", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c0", "content": "{}"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {"name": "look", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "{}"},
    ]

    out = agent._recent(messages)

    assert [m["role"] for m in out] == ["user", "assistant", "tool", "assistant", "tool"]
