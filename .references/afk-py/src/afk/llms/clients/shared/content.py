"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Module: clients/shared/content.py.
"""

from __future__ import annotations

import json
from typing import Any


def json_text(value: Any) -> str:
    """Serialize arbitrary values into deterministic JSON-safe text."""
    return json.dumps(value, ensure_ascii=True, default=str)


def normalize_role(role: str) -> str:
    """Normalize unsupported roles for Responses-style transports."""
    return role if role in ("user", "assistant", "system") else "user"


def tool_result_label(name: str | None) -> str:
    """Normalize tool label used in text fallback serialization."""
    return name or "tool"


def to_input_text_part(text: Any) -> dict[str, Any]:
    """Convert arbitrary text-ish content into one Responses input_text part."""
    return {"type": "input_text", "text": str(text)}
