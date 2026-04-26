"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Provider contracts for pluggable LLM transports.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from ..clients.contracts import LLMClientTransport
from ..middleware import MiddlewareStack
from ..observability import LLMObserver
from ..settings import LLMSettings
from ..types import JSONValue


class LLMTransport(LLMClientTransport, Protocol):
    """Provider transport interface consumed by runtime client."""


@dataclass(frozen=True, slots=True)
class ProviderSettingsSchema:
    """Minimal schema declaration for provider-specific settings."""

    required_keys: tuple[str, ...] = ()

    def validate(self, settings: Mapping[str, JSONValue] | None) -> None:
        if not self.required_keys:
            return
        row = settings or {}
        missing = [key for key in self.required_keys if key not in row]
        if missing:
            raise ValueError(
                f"Missing provider settings keys: {', '.join(sorted(missing))}"
            )


class LLMProvider(Protocol):
    """Provider factory contract for transport creation."""

    provider_id: str
    settings_schema: ProviderSettingsSchema

    def create_transport(
        self,
        *,
        settings: LLMSettings,
        middlewares: MiddlewareStack | None = None,
        observers: list[LLMObserver] | None = None,
        provider_settings: Mapping[str, JSONValue] | None = None,
    ) -> LLMTransport: ...
