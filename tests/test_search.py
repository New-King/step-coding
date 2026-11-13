from backend.search import dedupe


def test_dedupe_limits_same_host_and_duplicate_urls():
    results = [
        {"url": "https://a.com/1", "title": "1"},
        {"url": "https://a.com/2", "title": "2"},
        {"url": "https://a.com/3", "title": "3"},
        {"url": "https://b.com/1", "title": "4"},
        {"url": "https://a.com/1", "title": "dup"},
    ]
    out = dedupe(results)
    assert [r["title"] for r in out] == ["1", "2", "4"]


def test_dedupe_does_not_crash_on_malformed_url():
    out = dedupe([{"url": "http:/broken", "title": "x"}])
    assert len(out) == 1