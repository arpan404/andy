"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: routing/__init__.py.
"""

from .base import LLMRouter
from .defaults import OrderedFallbackRouter
from .registry import (
    LLMRouterError,
    create_llm_router,
    list_llm_routers,
    register_llm_router,
)

__all__ = [
    "LLMRouter",
    "OrderedFallbackRouter",
    "LLMRouterError",
    "register_llm_router",
    "create_llm_router",
    "list_llm_routers",
]
