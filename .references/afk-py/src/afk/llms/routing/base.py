"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: routing/base.py.
"""

from __future__ import annotations

from typing import Protocol

from ..types import LLMRequest


class LLMRouter(Protocol):
    """Protocol implemented by provider-routing strategies."""

    router_id: str

    def route(
        self,
        req: LLMRequest,
        *,
        available_providers: list[str],
        default_provider: str,
    ) -> list[str]: ...
