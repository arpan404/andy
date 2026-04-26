"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

No-op telemetry backend.
"""

from __future__ import annotations

from collections.abc import Mapping

from ...core.telemetry import TelemetryEvent, TelemetrySink, TelemetrySpan
from ...llms.types import JSONValue


class NullTelemetrySink:
    """No-op telemetry sink used as safe runtime default."""

    def record_event(self, event: TelemetryEvent) -> None:
        _ = event

    def start_span(
        self,
        name: str,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> TelemetrySpan | None:
        _ = name
        _ = attributes
        return None

    def end_span(
        self,
        span: TelemetrySpan | None,
        *,
        status: str,
        error: str | None = None,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        _ = span
        _ = status
        _ = error
        _ = attributes

    def increment_counter(
        self,
        name: str,
        value: int = 1,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        _ = name
        _ = value
        _ = attributes

    def record_histogram(
        self,
        name: str,
        value: float,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        _ = name
        _ = value
        _ = attributes


class NullTelemetryBackend:
    """Backend provider for no-op sink."""

    backend_id = "null"

    def create_sink(
        self,
        *,
        config: Mapping[str, JSONValue] | None = None,
    ) -> TelemetrySink:
        _ = config
        return NullTelemetrySink()
