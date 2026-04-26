"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: cache/registry.py.
"""

from __future__ import annotations

from threading import Lock

from .base import LLMCacheBackend
from .inmemory import InMemoryLLMCache

_REGISTRY: dict[str, LLMCacheBackend] = {}
_LOCK = Lock()


class LLMCacheError(RuntimeError):
    """Raised when cache backend resolution fails."""


def register_llm_cache_backend(
    backend: LLMCacheBackend,
    *,
    overwrite: bool = False,
) -> None:
    """Register one cache backend by `backend_id`."""
    key = backend.backend_id.strip().lower()
    if not key:
        raise LLMCacheError("Cache backend id must be non-empty")

    with _LOCK:
        if key in _REGISTRY and not overwrite:
            raise LLMCacheError(f"Cache backend already registered: {key}")
        _REGISTRY[key] = backend


def create_llm_cache(backend: str | LLMCacheBackend | None = None) -> LLMCacheBackend:
    """Resolve cache backend instance from id/instance/default."""
    if backend is None:
        key = "inmemory"
        with _LOCK:
            existing = _REGISTRY.get(key)
        if existing is not None:
            return existing
        cache = InMemoryLLMCache()
        register_llm_cache_backend(cache, overwrite=False)
        return cache

    if not isinstance(backend, str):
        return backend

    key = backend.strip().lower()
    with _LOCK:
        resolved = _REGISTRY.get(key)
    if resolved is None:
        raise LLMCacheError(f"Unknown LLM cache backend '{backend}'")
    return resolved


def list_llm_cache_backends() -> list[str]:
    """List registered cache backend ids."""
    with _LOCK:
        return sorted(_REGISTRY.keys())
