from backend.guards import claims_changed, claims_missing, repeat_streak, touched_paths


def test_claims_missing_catches_file_not_written():
    assert claims_missing("我写好了 quicksort.js", {}) == ["quicksort.js"]
    assert claims_missing("已经写了 README.md 和 index.html", {"index.html": ""}) == ["README.md"]


def test_delete_claim_is_not_a_write_claim():
    # "已删除 style.css" 不是"我说我写了它"，不能被守卫退回
    assert claims_missing("已删除 style.css 和 app.js", {"index.html": "<h1></h1>"}) == []


def test_claims_missing_accepts_nested_paths_and_existing_files():
    files = {"src/app.js": "x", "README.md": "y"}
    assert claims_missing("改好了 app.js，也更新了 README.md", files) == []


def test_claims_changed_catches_edit_claim_without_write():
    # 文件本来就在，只查存在拦不住：这句说的是「已经换成」，但这一轮一次写操作都没有
    text = "在。登录页的 index.html 已经换成登录表单了，app.js 还没写。"
    assert claims_changed(text, set()) == ["index.html"]


def test_claims_changed_accepts_file_touched_this_turn():
    text = "index.html 已经换成登录表单了。"
    assert claims_changed(text, {"index.html"}) == []


def test_touched_paths_only_counts_current_turn():
    messages = [
        {"role": "user", "content": "先做快排"},
        {
            "role": "assistant",
            "tool_calls": [{"function": {"name": "write_file", "arguments": '{"path": "app.js"}'}}],
        },
        {"role": "user", "content": "不要了，改成登录页"},
        {
            "role": "assistant",
            "tool_calls": [{"function": {"name": "edit_file", "arguments": '{"path": "index.html"}'}}],
        },
        {"role": "assistant", "tool_calls": [{"function": {"name": "look", "arguments": '{"path": "style.css"}'}}]},
    ]
    assert touched_paths(messages) == {"index.html"}


def test_repeat_streak_counts_consecutive_identical_calls():
    def same_call(text="hi", arg="1"):
        return [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {"name": "think", "arguments": f'{{"text": "{text}", "x": {arg}}}'},
                    }
                ],
            }
        ]

    messages = same_call() + same_call() + same_call()
    assert repeat_streak(messages) == 3
    assert repeat_streak(same_call() + same_call() + same_call(text="别的")) == 1


def test_repeat_streak_ignores_tool_results_between_calls():
    messages = []
    for _ in range(5):
        messages.append(
            {
                "role": "assistant",
                "tool_calls": [{"function": {"name": "look", "arguments": '{"path": ""}'}}],
            }
        )
        messages.append({"role": "tool", "content": "ok"})
    assert repeat_streak(messages) == 5