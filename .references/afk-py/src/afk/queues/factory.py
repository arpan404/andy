"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Factory helpers for selecting queue backends from environment variables.
"""

from __future__ import annotations

import os
from typing import Any

from .memory import InMemoryTaskQueue
from .types import TaskQueue


def _env_first(*names: str, default: str | None = None) -> str | None:
    """
    Return the first non-empty environment variable in `names`.

    Args:
        *names: Environment variable names to check in order.
        default: Value returned if no non-empty variable is found.
    """
    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue
        value = raw.strip()
        if value:
            return value
    return default


def create_task_queue_from_env(*, redis_client: Any | None = None) -> TaskQueue:
    """
    Create a task queue backend from `AFK_QUEUE_*` environment variables.

    Backends:
    - `inmemory` (default)
    - `redis`

    Redis resolution:
    - Uses the provided `redis_client` when supplied.
    - Otherwise builds a client from `AFK_QUEUE_REDIS_URL` (or `AFK_REDIS_URL`).
    - If no URL is set, falls back to host/port/db/password variables.
    """
    backend = os.getenv("AFK_QUEUE_BACKEND", "inmemory").strip().lower()
    backoff_base = float(
        _env_first("AFK_QUEUE_RETRY_BACKOFF_BASE_S", default="0.5") or "0.5"
    )
    backoff_max = float(
        _env_first("AFK_QUEUE_RETRY_BACKOFF_MAX_S", default="30") or "30"
    )
    backoff_jitter = float(
        _env_first("AFK_QUEUE_RETRY_BACKOFF_JITTER_S", default="0.2") or "0.2"
    )

    if backend in ("mem", "memory", "inmemory", "in_memory"):
        return InMemoryTaskQueue(
            retry_backoff_base_s=backoff_base,
            retry_backoff_max_s=backoff_max,
            retry_backoff_jitter_s=backoff_jitter,
        )

    if backend in ("redis",):
        from .redis_queue import RedisTaskQueue

        prefix = (
            _env_first("AFK_QUEUE_REDIS_PREFIX", default="afk:queue") or "afk:queue"
        )

        client = redis_client
        if client is None:
            try:
                import redis.asyncio as redis
            except ModuleNotFoundError as exc:  # pragma: no cover
                raise RuntimeError(
                    "Redis queue backend requires `redis` to be installed."
                ) from exc

            url = _env_first("AFK_QUEUE_REDIS_URL", "AFK_REDIS_URL")
            if not url:
                host = (
                    _env_first(
                        "AFK_QUEUE_REDIS_HOST", "AFK_REDIS_HOST", default="localhost"
                    )
                    or "localhost"
                )
                port = (
                    _env_first("AFK_QUEUE_REDIS_PORT", "AFK_REDIS_PORT", default="6379")
                    or "6379"
                )
                db = (
                    _env_first("AFK_QUEUE_REDIS_DB", "AFK_REDIS_DB", default="0") or "0"
                )
                password = (
                    _env_first(
                        "AFK_QUEUE_REDIS_PASSWORD", "AFK_REDIS_PASSWORD", default=""
                    )
                    or ""
                )
                if password:
                    url = f"redis://:{password}@{host}:{port}/{db}"
                else:
                    url = f"redis://{host}:{port}/{db}"

            client = redis.Redis.from_url(url)

        return RedisTaskQueue(
            client,
            prefix=prefix,
            retry_backoff_base_s=backoff_base,
            retry_backoff_max_s=backoff_max,
            retry_backoff_jitter_s=backoff_jitter,
        )

    raise ValueError(f"Unknown AFK_QUEUE_BACKEND: {backend}")
