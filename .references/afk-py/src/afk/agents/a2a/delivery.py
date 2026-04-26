"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Delivery durability stores for A2A protocol dedupe and dead-letter tracking.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Any, Protocol

from ..contracts import AgentDeadLetter, AgentInvocationResponse


class A2ADeliveryStore(Protocol):
    """Durability store contract for A2A delivery metadata."""

    async def get_success(self, idempotency_key: str) -> AgentInvocationResponse | None:
        """Return previously successful response for idempotency key."""
        ...

    async def record_success(
        self, idempotency_key: str, response: AgentInvocationResponse
    ) -> None:
        """Record successful response for dedupe replay."""
        ...

    async def record_dead_letter(self, dead_letter: AgentDeadLetter) -> None:
        """Persist one dead-letter event."""
        ...

    async def list_dead_letters(self) -> list[AgentDeadLetter]:
        """List dead-letter entries."""
        ...


class InMemoryA2ADeliveryStore:
    """In-memory durability store used by default and in tests."""

    def __init__(self) -> None:
        self._success: dict[str, AgentInvocationResponse] = {}
        self._dead_letters: list[AgentDeadLetter] = []
        self._lock = asyncio.Lock()

    async def get_success(self, idempotency_key: str) -> AgentInvocationResponse | None:
        async with self._lock:
            return self._success.get(idempotency_key)

    async def record_success(
        self,
        idempotency_key: str,
        response: AgentInvocationResponse,
    ) -> None:
        async with self._lock:
            self._success[idempotency_key] = response

    async def record_dead_letter(self, dead_letter: AgentDeadLetter) -> None:
        async with self._lock:
            self._dead_letters.append(dead_letter)

    async def list_dead_letters(self) -> list[AgentDeadLetter]:
        async with self._lock:
            return list(self._dead_letters)


class RedisA2ADeliveryStore:
    """Redis-backed durability store for distributed A2A deployments."""

    def __init__(self, redis: Any, *, prefix: str = "afk:a2a") -> None:
        self._redis = redis
        self._prefix = prefix

    def _success_key(self, idempotency_key: str) -> str:
        return f"{self._prefix}:success:{idempotency_key}"

    def _dead_letter_key(self) -> str:
        return f"{self._prefix}:dead_letters"

    async def get_success(self, idempotency_key: str) -> AgentInvocationResponse | None:
        raw = await self._redis.get(self._success_key(idempotency_key))
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(raw)
        return AgentInvocationResponse(**payload)

    async def record_success(
        self,
        idempotency_key: str,
        response: AgentInvocationResponse,
    ) -> None:
        payload = json.dumps(asdict(response), ensure_ascii=True)
        await self._redis.set(self._success_key(idempotency_key), payload)

    async def record_dead_letter(self, dead_letter: AgentDeadLetter) -> None:
        payload = json.dumps(asdict(dead_letter), ensure_ascii=True)
        await self._redis.rpush(self._dead_letter_key(), payload)

    async def list_dead_letters(self) -> list[AgentDeadLetter]:
        rows = await self._redis.lrange(self._dead_letter_key(), 0, -1)
        out: list[AgentDeadLetter] = []
        for row in rows:
            raw = row.decode("utf-8") if isinstance(row, bytes) else row
            payload = json.loads(raw)
            out.append(AgentDeadLetter(**payload))
        return out
