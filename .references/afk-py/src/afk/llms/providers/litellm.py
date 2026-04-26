"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: providers/litellm.py.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..clients.adapters.litellm import LiteLLMClient
from ..middleware import MiddlewareStack
from ..observability import LLMObserver
from ..settings import LLMSettings
from ..types import JSONValue
from .contracts import LLMProvider, LLMTransport, ProviderSettingsSchema


class LiteLLMProvider(LLMProvider):
    """Provider factory for `LiteLLMClient` transports."""

    provider_id = "litellm"
    settings_schema = ProviderSettingsSchema()

    def create_transport(
        self,
        *,
        settings: LLMSettings,
        middlewares: MiddlewareStack | None = None,
        observers: list[LLMObserver] | None = None,
        provider_settings: Mapping[str, JSONValue] | None = None,
    ) -> LLMTransport:
        """Create one LiteLLM transport configured from shared settings."""
        self.settings_schema.validate(provider_settings)
        row = provider_settings or {}
        return LiteLLMClient(
            config=settings.to_legacy_config(),
            middlewares=middlewares,
            observers=observers,
            thinking_effort_aliases=row.get("thinking_effort_aliases")
            if isinstance(row.get("thinking_effort_aliases"), dict)
            else None,
            supported_thinking_efforts=set(row.get("supported_thinking_efforts"))
            if isinstance(row.get("supported_thinking_efforts"), list)
            else None,
            default_thinking_effort=row.get("default_thinking_effort")
            if isinstance(row.get("default_thinking_effort"), str)
            else None,
        )
