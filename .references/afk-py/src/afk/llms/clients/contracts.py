"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Typed transport contracts for llms client adapters.
"""

from __future__ import annotations

from typing import Any, Protocol

from ..types import (
    EmbeddingRequest,
    EmbeddingResponse,
    LLMCapabilities,
    LLMRequest,
    LLMResponse,
    LLMSessionHandle,
    LLMStreamHandle,
)


class LLMClientTransport(Protocol):
    """Adapter-facing transport interface consumed by the runtime client."""

    @property
    def provider_id(self) -> str: ...

    @property
    def capabilities(self) -> LLMCapabilities: ...

    async def chat(
        self,
        req: LLMRequest,
        *,
        response_model: type[Any] | None = None,
    ) -> LLMResponse: ...

    async def chat_stream(
        self,
        req: LLMRequest,
        *,
        response_model: type[Any] | None = None,
    ): ...

    async def chat_stream_handle(
        self,
        req: LLMRequest,
        *,
        response_model: type[Any] | None = None,
    ) -> LLMStreamHandle: ...

    async def embed(self, req: EmbeddingRequest) -> EmbeddingResponse: ...

    def start_session(
        self,
        *,
        session_token: str | None = None,
        checkpoint_token: str | None = None,
    ) -> LLMSessionHandle: ...
