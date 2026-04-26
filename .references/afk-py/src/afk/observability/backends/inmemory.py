"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

In-memory telemetry backend for tests and local debugging.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ...core.telemetry import TelemetryEvent, TelemetrySink, TelemetrySpan, now_ms
from ...llms.types import JSONValue


@dataclass(slots=True)
class InMemoryTelemetrySink:
    """Telemetry sink that stores emitted records in process memory."""

    _events: list[TelemetryEvent] = field(default_factory=list)
    _spans_closed: list[dict[str, Any]] = field(default_factory=list)
    _counters: list[dict[str, Any]] = field(default_factory=list)
    _histograms: list[dict[str, Any]] = field(default_factory=list)

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
            started_at_ms=now_ms(),
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
        ended_at = now_ms()
        self._spans_closed.append(
            {
                "name": span.name,
                "started_at_ms": span.started_at_ms,
                "ended_at_ms": ended_at,
                "duration_ms": ended_at - span.started_at_ms,
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
                "timestamp_ms": now_ms(),
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
                "timestamp_ms": now_ms(),
            }
        )

    def events(self) -> list[TelemetryEvent]:
        return list(self._events)

    def spans(self) -> list[dict[str, Any]]:
        return list(self._spans_closed)

    def counters(self) -> list[dict[str, Any]]:
        return list(self._counters)

    def histograms(self) -> list[dict[str, Any]]:
        return list(self._histograms)


class InMemoryTelemetryBackend:
    """Backend provider for in-memory sink."""

    backend_id = "inmemory"

    def create_sink(
        self,
        *,
        config: Mapping[str, JSONValue] | None = None,
    ) -> TelemetrySink:
        _ = config
        return InMemoryTelemetrySink()
