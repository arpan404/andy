"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Quickstart re-exports for common AFK usage.

Usage::

    from afk.quickstart import Agent, tool, Runner, ToolResult, AgentResult
"""

from __future__ import annotations

from .agents import Agent
from .agents.types import AgentResult
from .core.runner import Runner
from .tools.core.base import ToolResult
from .tools.core.decorator import tool

__all__ = [
    "Agent",
    "AgentResult",
    "Runner",
    "ToolResult",
    "tool",
]
