"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: runtime/rate_limit.py.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from .contracts import RateLimitPolicy


@dataclass(slots=True)
class _Bucket:
    """Data type for bucket."""

    tokens: float
    updated_at_s: float


class RateLimiter:
    """Concurrency-safe token bucket limiter keyed by provider/op."""

    def __init__(self) -> None:
        self._rows: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, key: str, policy: RateLimitPolicy) -> None:
        if policy.requests_per_second <= 0:
            return
        while True:
            async with self._lock:
                now = time.monotonic()
                bucket = self._rows.get(key)
                if bucket is None:
                    bucket = _Bucket(tokens=float(policy.burst), updated_at_s=now)
                    self._rows[key] = bucket

                elapsed = max(0.0, now - bucket.updated_at_s)
                bucket.tokens = min(
                    float(policy.burst),
                    bucket.tokens + elapsed * policy.requests_per_second,
                )
                bucket.updated_at_s = now

                if bucket.tokens >= 1.0:
                    bucket.tokens -= 1.0
                    return

                wait_s = (1.0 - bucket.tokens) / policy.requests_per_second
            await asyncio.sleep(max(wait_s, 0.001))
