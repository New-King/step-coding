"""Agent 层的错误类型。单独放，避免循环导入。"""

from __future__ import annotations


class AgentError(RuntimeError):
    pass


class TruncatedError(AgentError):
    """模型输出因 max_tokens 被截断，工具参数通常已经残缺。"""
