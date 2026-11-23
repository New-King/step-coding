import pytest

from backend import usage


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    """额度落在 var/usage 里：测试里换成临时目录，别碰真文件。"""
    monkeypatch.setattr(usage, "STORE", tmp_path)
    return tmp_path


def test_per_device_limit(monkeypatch):
    monkeypatch.setenv("DAILY_TOKEN_LIMIT", "100")
    usage.add("1.1.1.1|a", 60)
    assert usage.over("1.1.1.1|a") is False
    usage.add("1.1.1.1|a", 40)
    assert usage.over("1.1.1.1|a") is True
    # 另一台设备是另一份额度
    assert usage.over("2.2.2.2|b") is False


def test_total_counts_every_device(monkeypatch):
    """全站预算跟是谁无关：不同 IP、不同浏览器都算进同一个总数。"""
    monkeypatch.setenv("DAILY_TOKEN_LIMIT", "100")
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "150")
    usage.add("1.1.1.1|a", 80)
    usage.add("2.2.2.2|b", 60)

    assert usage.total() == 140
    assert usage.over_all() is False
    # 单设备额度都没超，但全站已经快满了
    assert usage.over("1.1.1.1|a") is False

    usage.add("3.3.3.3|c", 10)
    assert usage.total() == 150
    assert usage.over_all() is True


def test_zero_means_unlimited(monkeypatch):
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "0")
    usage.add("1.1.1.1|a", 999_999)
    assert usage.over_all() is False


def test_only_today_is_kept(tmp_path):
    """不存历史：昨天的文件在零点后第一次访问时删掉，额度从 0 重算。"""
    old = tmp_path / "2000-01-01.json"
    old.write_text('{"__total__": 999, "1.1.1.1|a": 999}', encoding="utf-8")

    assert usage.total() == 0  # 读的是今天的文件，跟昨天那 999 无关
    assert not old.exists()  # 顺手把昨天那份删了

    usage.add("1.1.1.1|a", 10)
    assert (tmp_path / f"{usage.today()}.json").exists()
    assert usage.used("1.1.1.1|a") == 10


def test_snapshot_reports_used_and_limit(monkeypatch):
    monkeypatch.setenv("DAILY_TOTAL_LIMIT", "1000000")
    usage.add("1.1.1.1|a", 62_340)
    assert usage.snapshot() == {"used": 62_340, "limit": 1_000_000}
