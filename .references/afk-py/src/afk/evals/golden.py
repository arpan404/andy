"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Golden-trace helpers for deterministic eval assertions.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..agents.types import AgentRunEvent


def write_golden_trace(path: str | Path, events: list[AgentRunEvent]) -> None:
    """Write normalized run-event rows to a deterministic golden JSON file."""

    rows = [
        {
            "type": event.type,
            "state": event.state,
            "step": event.step,
            "message": event.message,
            "data": event.data,
        }
        for event in events
    ]
    Path(path).write_text(
        json.dumps(rows, ensure_ascii=True, indent=2), encoding="utf-8"
    )


def compare_event_types(
    expected: list[str],
    observed: list[str],
) -> tuple[bool, str | None]:
    """Compare expected and observed event type sequences."""

    if expected == observed:
        return True, None
    return False, f"expected={expected} observed={observed}"
