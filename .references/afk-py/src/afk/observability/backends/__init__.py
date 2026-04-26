"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Telemetry backend providers and registry utilities.
"""

from .base import TelemetryBackend
from .inmemory import InMemoryTelemetryBackend, InMemoryTelemetrySink
from .null import NullTelemetryBackend, NullTelemetrySink
from .otel import OpenTelemetryBackend, OpenTelemetrySink
from .registry import (
    TelemetryBackendError,
    create_telemetry_sink,
    get_telemetry_backend,
    list_telemetry_backends,
    register_telemetry_backend,
)

# Register built-ins at import time.
register_telemetry_backend(NullTelemetryBackend())
register_telemetry_backend(InMemoryTelemetryBackend())
register_telemetry_backend(OpenTelemetryBackend())

__all__ = [
    "TelemetryBackend",
    "TelemetryBackendError",
    "register_telemetry_backend",
    "get_telemetry_backend",
    "list_telemetry_backends",
    "create_telemetry_sink",
    "NullTelemetryBackend",
    "InMemoryTelemetryBackend",
    "OpenTelemetryBackend",
    "NullTelemetrySink",
    "InMemoryTelemetrySink",
    "OpenTelemetrySink",
]
