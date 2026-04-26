"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Thread-safe registry for LLM providers.
"""

from __future__ import annotations

from threading import Lock

from .contracts import LLMProvider

_REGISTRY: dict[str, LLMProvider] = {}
_LOCK = Lock()


class LLMProviderError(RuntimeError):
    """Raised when provider registration/resolution fails."""


def register_llm_provider(provider: LLMProvider, *, overwrite: bool = False) -> None:
    """Register one provider under its stable id."""
    provider_id = provider.provider_id.strip().lower()
    if not provider_id:
        raise LLMProviderError("Provider id must be non-empty")

    with _LOCK:
        if provider_id in _REGISTRY and not overwrite:
            raise LLMProviderError(f"Provider already registered: {provider_id}")
        _REGISTRY[provider_id] = provider


def get_llm_provider(provider_id: str) -> LLMProvider:
    """Resolve one registered provider by id."""
    key = provider_id.strip().lower()
    with _LOCK:
        provider = _REGISTRY.get(key)
    if provider is None:
        raise LLMProviderError(f"Unknown LLM provider '{provider_id}'")
    return provider


def list_llm_providers() -> list[str]:
    """List registered provider ids in deterministic order."""
    with _LOCK:
        return sorted(_REGISTRY.keys())
