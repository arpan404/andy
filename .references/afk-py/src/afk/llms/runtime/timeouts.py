"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: runtime/timeouts.py.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from typing import TypeVar

T = TypeVar("T")


async def await_with_timeout(awaitable: Awaitable[T], timeout_s: float | None) -> T:
    """Await value with optional timeout."""
    if timeout_s is None:
        return await awaitable
    return await asyncio.wait_for(awaitable, timeout=timeout_s)


async def iter_with_idle_timeout(
    stream: AsyncIterator[T],
    *,
    idle_timeout_s: float | None,
) -> AsyncIterator[T]:
    """Wrap stream iteration with per-item idle timeout."""
    if idle_timeout_s is None:
        async for item in stream:
            yield item
        return

    while True:
        try:
            item = await asyncio.wait_for(anext(stream), timeout=idle_timeout_s)
        except StopAsyncIteration:
            return
        yield item
