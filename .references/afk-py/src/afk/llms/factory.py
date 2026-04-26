"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: factory.py.
"""

from __future__ import annotations

from .errors import LLMConfigurationError


def _removed() -> None:
    """Raise v2 hard-break error for removed legacy factory entrypoints."""
    raise LLMConfigurationError(
        "Legacy factory APIs are removed in llms v2. "
        "Use create_llm_client(...) or LLMBuilder()."
    )


def register_llm_adapter(*args, **kwargs):  # type: ignore[no-untyped-def]
    """Removed legacy API shim."""
    _removed()


def available_llm_adapters(*args, **kwargs):  # type: ignore[no-untyped-def]
    """Removed legacy API shim."""
    _removed()


def create_llm(*args, **kwargs):  # type: ignore[no-untyped-def]
    """Removed legacy API shim."""
    _removed()


def create_llm_from_env(*args, **kwargs):  # type: ignore[no-untyped-def]
    """Removed legacy API shim."""
    _removed()
