"""Agent 层的错误类型。单独放，避免循环导入。"""

from __future__ import annotations


class AgentError(RuntimeError):
    pass
