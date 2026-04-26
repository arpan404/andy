"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Telemetry event/span types and sink protocol.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..llms.types import JSONValue


@dataclass(frozen=True, slots=True)
class TelemetryEvent:
    """Point-in-time telemetry event payload."""

    name: str
    timestamp_ms: int
    attributes: dict[str, JSONValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TelemetrySpan:
    """Started telemetry span payload."""

    name: str
    started_at_ms: int
    attributes: dict[str, JSONValue] = field(default_factory=dict)
    native_span: Any = None


class TelemetrySink(Protocol):
    """Protocol implemented by telemetry sink backends."""

    def record_event(self, event: TelemetryEvent) -> None:
        """Record one point-in-time telemetry event."""
        ...

    def start_span(
        self,
        name: str,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> TelemetrySpan | None:
        """Start one span and return sink span handle when supported."""
        ...

    def end_span(
        self,
        span: TelemetrySpan | None,
        *,
        status: str,
        error: str | None = None,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        """End one span with terminal status metadata."""
        ...

    def increment_counter(
        self,
        name: str,
        value: int = 1,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        """Emit one counter increment data point."""
        ...

    def record_histogram(
        self,
        name: str,
        value: float,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        """Emit one histogram measurement data point."""
        ...


def now_ms() -> int:
    """Return current Unix epoch time in milliseconds."""

    return int(time.time() * 1000)
