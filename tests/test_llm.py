import io
import urllib.error

import pytest

from backend import agent
from backend.agent_error import AgentError, TruncatedError


def valid_payload(name: str = "think", args: str = '{"text": "hi"}'):
    return {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": name, "arguments": args},
                        }
                    ],
                },
            }
        ]
    }


@pytest.fixture(autouse=True)
def llm_env(monkeypatch):
    monkeypatch.setattr(agent, "API_KEY", "test-key")
    monkeypatch.setattr(agent, "LLM_RETRIES", 1)
    monkeypatch.setattr(agent, "LLM_TIMEOUT", 5)
    monkeypatch.setattr(agent, "LLM_MAX_TOKENS", 6000)
    monkeypatch.setattr(agent.time, "sleep", lambda _: None)


def test_call_parses_tool_call(monkeypatch):
    monkeypatch.setattr(agent, "_post", lambda payload: valid_payload())
    action, assistant, call = agent._call([{"role": "user", "content": "hi"}])
    assert action == {"action": "think", "text": "hi"}
    assert assistant["tool_calls"][0]["id"] == "c1"
    assert call["id"] == "c1"


def test_call_raises_truncated_before_parsing_args(monkeypatch):
    payload = {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
    monkeypatch.setattr(agent, "_post", lambda _: payload)
    with pytest.raises(TruncatedError):
        agent._call([])


def test_invalid_tool_arguments_are_reported(monkeypatch):
    payload = valid_payload(args='{"text": "hi"')
    monkeypatch.setattr(agent, "_post", lambda _: payload)
    with pytest.raises(AgentError) as err:
        agent._call([])
    assert "合法 JSON" in str(err.value)


def test_5xx_is_retried_once(monkeypatch):
    calls = []

    def fake(payload):
        calls.append(payload)
        if len(calls) == 1:
            raise urllib.error.HTTPError(
                "url", 503, "busy", {}, io.BytesIO(b'{"error":"busy"}')
            )
        return valid_payload()

    monkeypatch.setattr(agent, "_post", fake)
    action, _, _ = agent._call([])
    assert action["action"] == "think"
    assert len(calls) == 2


def test_401_is_not_retried(monkeypatch):
    calls = []

    def fake(_):
        calls.append(1)
        raise urllib.error.HTTPError("url", 401, "unauthorized", {}, io.BytesIO(b"{}"))

    monkeypatch.setattr(agent, "_post", fake)
    with pytest.raises(AgentError) as err:
        agent._call([])
    assert "HTTP 401" in str(err.value)
    assert len(calls) == 1


def test_timeout_is_reported_after_retry_budget(monkeypatch):
    calls = []

    def fake(_):
        calls.append(1)
        raise TimeoutError("timed out")

    monkeypatch.setattr(agent, "_post", fake)
    with pytest.raises(AgentError) as err:
        agent._call([])
    assert "超时" in str(err.value)
    assert len(calls) == 2