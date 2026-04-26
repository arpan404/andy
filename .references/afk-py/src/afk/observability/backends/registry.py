"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Registry for pluggable telemetry backends.
"""

from __future__ import annotations

from collections.abc import Mapping
from threading import Lock

from ...core.telemetry import TelemetrySink
from ...llms.types import JSONValue
from .base import TelemetryBackend

_BACKENDS: dict[str, TelemetryBackend] = {}
_LOCK = Lock()


class TelemetryBackendError(RuntimeError):
    """Raised when telemetry backend registration/resolution fails."""


def register_telemetry_backend(backend: TelemetryBackend) -> None:
    """Register one telemetry backend by its stable backend id."""
    backend_id = str(backend.backend_id).strip().lower()
    if not backend_id:
        raise TelemetryBackendError("Telemetry backend id must be non-empty")
    with _LOCK:
        _BACKENDS[backend_id] = backend


def get_telemetry_backend(backend_id: str) -> TelemetryBackend:
    """Resolve one telemetry backend by id."""
    key = str(backend_id).strip().lower()
    with _LOCK:
        backend = _BACKENDS.get(key)
    if backend is None:
        raise TelemetryBackendError(f"Unknown telemetry backend '{backend_id}'")
    return backend


def list_telemetry_backends() -> list[str]:
    """Return sorted list of registered telemetry backend ids."""
    with _LOCK:
        return sorted(_BACKENDS.keys())


def create_telemetry_sink(
    backend: str | TelemetrySink | None = None,
    *,
    config: Mapping[str, JSONValue] | None = None,
) -> TelemetrySink:
    """
    Resolve sink from backend id or passthrough provided sink instance.

    Args:
        backend: Backend id (`null`, `inmemory`, `otel`) or sink instance.
        config: Optional backend-specific configuration payload.

    Returns:
        Materialized telemetry sink.
    """
    if backend is None:
        resolved_id = "null"
        return get_telemetry_backend(resolved_id).create_sink(config=config)
    if not isinstance(backend, str):
        return backend
    return get_telemetry_backend(backend).create_sink(config=config)
