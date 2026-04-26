"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Runtime telemetry collector used for in-process metrics projection.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ...core.telemetry import TelemetryEvent, TelemetrySink, TelemetrySpan
from ...llms.types import JSONValue


@dataclass(slots=True)
class RuntimeTelemetryCollector(TelemetrySink):
    """Telemetry sink that captures runtime telemetry for metrics projection."""

    _events: list[TelemetryEvent] = field(default_factory=list)
    _spans: list[dict[str, Any]] = field(default_factory=list)
    _counters: list[dict[str, Any]] = field(default_factory=list)
    _histograms: list[dict[str, Any]] = field(default_factory=list)
    _started_at: float = field(default_factory=time.time)

    def record_event(self, event: TelemetryEvent) -> None:
        self._events.append(event)

    def start_span(
        self,
        name: str,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> TelemetrySpan:
        return TelemetrySpan(
            name=name,
            started_at_ms=int(time.time() * 1000),
            attributes=dict(attributes or {}),
        )

    def end_span(
        self,
        span: TelemetrySpan | None,
        *,
        status: str,
        error: str | None = None,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        if span is None:
            return
        now_ms = int(time.time() * 1000)
        self._spans.append(
            {
                "name": span.name,
                "started_at_ms": span.started_at_ms,
                "ended_at_ms": now_ms,
                "duration_ms": now_ms - span.started_at_ms,
                "status": status,
                "error": error,
                "attributes": {**span.attributes, **dict(attributes or {})},
            }
        )

    def increment_counter(
        self,
        name: str,
        value: int = 1,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        self._counters.append(
            {
                "name": name,
                "value": int(value),
                "attributes": dict(attributes or {}),
                "timestamp_ms": int(time.time() * 1000),
            }
        )

    def record_histogram(
        self,
        name: str,
        value: float,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        self._histograms.append(
            {
                "name": name,
                "value": float(value),
                "attributes": dict(attributes or {}),
                "timestamp_ms": int(time.time() * 1000),
            }
        )

    def events(self) -> list[TelemetryEvent]:
        """Return collected telemetry events."""

        return list(self._events)

    def spans(self) -> list[dict[str, Any]]:
        """Return collected telemetry span records."""

        return list(self._spans)

    def counters(self) -> list[dict[str, Any]]:
        """Return collected telemetry counter records."""

        return list(self._counters)

    def histograms(self) -> list[dict[str, Any]]:
        """Return collected telemetry histogram records."""

        return list(self._histograms)

    def started_at(self) -> float:
        """Return collector start time (seconds since epoch)."""

        return self._started_at

    def reset(self) -> None:
        """Clear collected telemetry records for collector reuse."""

        self._events.clear()
        self._spans.clear()
        self._counters.clear()
        self._histograms.clear()
        self._started_at = time.time()
