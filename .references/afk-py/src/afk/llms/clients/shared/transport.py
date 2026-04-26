"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: clients/shared/transport.py.
"""

from __future__ import annotations

from typing import Any


def collect_headers(
    existing_headers: Any,
    *,
    idempotency_key: Any,
    metadata: Any,
) -> dict[str, str]:
    """Build normalized string-only transport headers map."""
    headers: dict[str, str] = {}

    if isinstance(existing_headers, dict):
        for key, value in existing_headers.items():
            if isinstance(key, str) and isinstance(value, str):
                headers[key] = value

    if isinstance(idempotency_key, str) and idempotency_key:
        headers.setdefault("Idempotency-Key", idempotency_key)

    if isinstance(metadata, dict):
        request_id = metadata.get("afk_request_id")
        if isinstance(request_id, str) and request_id:
            headers.setdefault("X-Request-Id", request_id)

    return headers
