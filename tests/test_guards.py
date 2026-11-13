from backend.guards import claims_missing, repeat_streak


def test_claims_missing_catches_file_not_written():
    assert claims_missing("我写好了 quicksort.js", {}) == ["quicksort.js"]
    assert claims_missing("已经写了 README.md 和 index.html", {"index.html": ""}) == ["README.md"]


def test_claims_missing_accepts_nested_paths_and_existing_files():
    files = {"src/app.js": "x", "README.md": "y"}
    assert claims_missing("改好了 app.js，也更新了 README.md", files) == []


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