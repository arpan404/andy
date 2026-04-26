"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

OpenTelemetry backend for enterprise telemetry pipelines.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ...core.telemetry import TelemetryEvent, TelemetrySink, TelemetrySpan, now_ms
from ...llms.types import JSONValue


@dataclass(slots=True)
class OpenTelemetrySink:
    """OpenTelemetry sink with lazy tracer and meter initialization."""

    service_name: str = "afk-agent-runtime"
    tracer_name: str = "afk.core.runner"
    meter_name: str = "afk.core.runner"

    _tracer: Any = field(default=None, init=False, repr=False)
    _meter: Any = field(default=None, init=False, repr=False)
    _counters: dict[str, Any] = field(default_factory=dict, init=False, repr=False)
    _histograms: dict[str, Any] = field(default_factory=dict, init=False, repr=False)

    def _ensure_clients(self) -> None:
        if self._tracer is not None and self._meter is not None:
            return
        try:
            from opentelemetry import metrics, trace
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                "OpenTelemetrySink requires 'opentelemetry-api'/'opentelemetry-sdk'"
            ) from exc
        self._tracer = trace.get_tracer(self.tracer_name)
        self._meter = metrics.get_meter(self.meter_name)

    def _attr(self, value: Mapping[str, JSONValue] | None) -> dict[str, Any]:
        attrs: dict[str, Any] = {}
        for key, item in (value or {}).items():
            attrs[str(key)] = _to_attr(item)
        return attrs

    def record_event(self, event: TelemetryEvent) -> None:
        self.increment_counter(
            "agent.events",
            value=1,
            attributes={"event_name": event.name, **event.attributes},
        )

    def start_span(
        self,
        name: str,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> TelemetrySpan | None:
        try:
            self._ensure_clients()
            span = self._tracer.start_span(name=name)
            attr = self._attr(attributes)
            if attr:
                span.set_attributes(attr)
            return TelemetrySpan(
                name=name,
                started_at_ms=now_ms(),
                attributes=dict(attributes or {}),
                native_span=span,
            )
        except Exception:  # pragma: no cover
            return None

    def end_span(
        self,
        span: TelemetrySpan | None,
        *,
        status: str,
        error: str | None = None,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        if span is None or span.native_span is None:
            return
        try:  # pragma: no cover
            from opentelemetry.trace import Status, StatusCode

            native = span.native_span
            merged = {**span.attributes, **dict(attributes or {})}
            attr = self._attr(merged)
            if attr:
                native.set_attributes(attr)
            if error:
                native.record_exception(Exception(error))
            if status == "ok":
                native.set_status(Status(StatusCode.OK))
            else:
                native.set_status(Status(StatusCode.ERROR, error or status))
            native.end()
        except Exception:
            return

    def increment_counter(
        self,
        name: str,
        value: int = 1,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        try:
            self._ensure_clients()
            counter = self._counters.get(name)
            if counter is None:
                counter = self._meter.create_counter(name)
                self._counters[name] = counter
            counter.add(int(value), attributes=self._attr(attributes))
        except Exception:  # pragma: no cover
            return

    def record_histogram(
        self,
        name: str,
        value: float,
        *,
        attributes: dict[str, JSONValue] | None = None,
    ) -> None:
        try:
            self._ensure_clients()
            histogram = self._histograms.get(name)
            if histogram is None:
                histogram = self._meter.create_histogram(name)
                self._histograms[name] = histogram
            histogram.record(float(value), attributes=self._attr(attributes))
        except Exception:  # pragma: no cover
            return


class OpenTelemetryBackend:
    """Backend provider for OpenTelemetry sink."""

    backend_id = "otel"

    def create_sink(
        self,
        *,
        config: Mapping[str, JSONValue] | None = None,
    ) -> TelemetrySink:
        conf = dict(config or {})
        return OpenTelemetrySink(
            service_name=str(conf.get("service_name", "afk-agent-runtime")),
            tracer_name=str(conf.get("tracer_name", "afk.core.runner")),
            meter_name=str(conf.get("meter_name", "afk.core.runner")),
        )


def _to_attr(value: JSONValue) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return tuple(_to_attr(item) for item in value)
    if isinstance(value, dict):
        return str(value)
    return str(value)
