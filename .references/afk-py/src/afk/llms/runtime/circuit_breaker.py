"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: runtime/circuit_breaker.py.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from ..errors import LLMRetryableError
from .contracts import CircuitBreakerPolicy


@dataclass(slots=True)
class _State:
    """Data type for state."""

    failures: int = 0
    opened_at_s: float | None = None
    half_open_calls: int = 0


class CircuitBreaker:
    """Concurrency-safe breaker with half-open probe support."""

    def __init__(self) -> None:
        self._rows: dict[str, _State] = {}
        self._lock = asyncio.Lock()

    async def ensure_available(self, key: str, policy: CircuitBreakerPolicy) -> None:
        async with self._lock:
            state = self._rows.setdefault(key, _State())
            if state.opened_at_s is None:
                return
            age = time.monotonic() - state.opened_at_s
            if age >= policy.cooldown_s:
                if state.half_open_calls < policy.half_open_max_calls:
                    state.half_open_calls += 1
                    return
            raise LLMRetryableError(f"Circuit open for key '{key}'")

    async def record_success(self, key: str) -> None:
        async with self._lock:
            self._rows[key] = _State()

    async def record_failure(self, key: str, policy: CircuitBreakerPolicy) -> None:
        async with self._lock:
            state = self._rows.setdefault(key, _State())
            state.failures += 1
            if state.failures >= policy.failure_threshold:
                state.opened_at_s = time.monotonic()
                state.half_open_calls = 0
