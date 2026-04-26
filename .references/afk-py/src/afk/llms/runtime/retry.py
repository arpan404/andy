"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: runtime/retry.py.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Awaitable, Callable
from typing import TypeVar

from ..errors import LLMError, LLMRetryableError, LLMTimeoutError
from ..runtime.contracts import RetryPolicy
from ..utils import backoff_delay

T = TypeVar("T")


def classify_error(error: Exception) -> LLMError:
    """Classify exceptions into retryable/non-retryable AFK errors."""
    if isinstance(error, LLMError):
        return error
    if isinstance(error, (asyncio.TimeoutError, TimeoutError, socket.timeout)):
        return LLMTimeoutError(str(error))
    if isinstance(error, (ConnectionError, OSError)):
        return LLMRetryableError(str(error))

    msg = str(error).lower()
    retry_phrases = (
        "rate limit",
        "timeout",
        "temporarily",
        "overloaded",
        "service unavailable",
        "429",
        "502",
        "503",
        "504",
    )
    if any(token in msg for token in retry_phrases):
        return LLMRetryableError(str(error))
    return LLMError(str(error))


async def call_with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    policy: RetryPolicy,
    can_retry: bool,
) -> T:
    """Execute callable under bounded retry policy."""
    retries = policy.max_retries if can_retry else 0
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return await fn()
        except Exception as error:
            classified = classify_error(error)
            last = classified
            if isinstance(classified, LLMRetryableError) and attempt < retries:
                await asyncio.sleep(
                    backoff_delay(
                        attempt,
                        policy.backoff_base_s,
                        policy.backoff_jitter_s,
                    )
                )
                continue
            raise classified from error
    raise LLMError("Retry loop exhausted") from last
