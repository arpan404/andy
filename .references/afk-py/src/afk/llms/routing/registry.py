"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: routing/registry.py.
"""

from __future__ import annotations

from threading import Lock

from .base import LLMRouter
from .defaults import OrderedFallbackRouter

_REGISTRY: dict[str, LLMRouter] = {}
_LOCK = Lock()


class LLMRouterError(RuntimeError):
    """Raised when router registration or resolution fails."""


def register_llm_router(router: LLMRouter, *, overwrite: bool = False) -> None:
    """Register one router by `router_id`."""
    key = router.router_id.strip().lower()
    if not key:
        raise LLMRouterError("Router id must be non-empty")
    with _LOCK:
        if key in _REGISTRY and not overwrite:
            raise LLMRouterError(f"Router already registered: {key}")
        _REGISTRY[key] = router


def create_llm_router(router: str | LLMRouter | None = None) -> LLMRouter:
    """Resolve router instance from id/instance/default."""
    if router is None:
        key = "ordered_fallback"
        with _LOCK:
            existing = _REGISTRY.get(key)
        if existing is not None:
            return existing
        instance = OrderedFallbackRouter()
        register_llm_router(instance)
        return instance

    if not isinstance(router, str):
        return router

    key = router.strip().lower()
    with _LOCK:
        resolved = _REGISTRY.get(key)
    if resolved is None:
        raise LLMRouterError(f"Unknown LLM router '{router}'")
    return resolved


def list_llm_routers() -> list[str]:
    """List registered router ids."""
    with _LOCK:
        return sorted(_REGISTRY.keys())
