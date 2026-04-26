from __future__ import annotations

from collections.abc import Mapping
from uuid import uuid4

import pytest

from afk.core.telemetry import TelemetryEvent, TelemetrySink, TelemetrySpan
from afk.llms.types import JSONValue
from afk.observability.backends import (
    TelemetryBackendError,
    create_telemetry_sink,
    register_telemetry_backend,
)


class _CustomSink:
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


class _CustomBackend:
    def __init__(self, backend_id: str) -> None:
        self.backend_id = backend_id

    def create_sink(
        self,
        *,
        config: Mapping[str, JSONValue] | None = None,
    ) -> TelemetrySink:
        _ = config
        return _CustomSink()


def test_register_and_resolve_custom_backend():
    backend_id = f"custom-{uuid4().hex}"
    register_telemetry_backend(_CustomBackend(backend_id))
    sink = create_telemetry_sink(backend_id)
    assert isinstance(sink, _CustomSink)


def test_unknown_backend_raises_error():
    with pytest.raises(TelemetryBackendError):
        create_telemetry_sink("unknown-backend")
