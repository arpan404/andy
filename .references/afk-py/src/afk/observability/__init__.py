"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Observability package exports for telemetry contracts and backends.
"""

from . import contracts
from .backends import (
    InMemoryTelemetrySink,
    NullTelemetrySink,
    OpenTelemetrySink,
    TelemetryBackend,
    TelemetryBackendError,
    create_telemetry_sink,
    get_telemetry_backend,
    list_telemetry_backends,
    register_telemetry_backend,
)
from .collectors import RuntimeTelemetryCollector
from .exporters import (
    ConsoleRunMetricsExporter,
    JSONLRunMetricsExporter,
    JSONRunMetricsExporter,
    RunMetricsExporter,
)
from .models import RunMetrics
from .projectors import (
    project_run_metrics_from_collector,
    project_run_metrics_from_result,
    run_metrics_schema_version,
)

__all__ = [
    "contracts",
    "TelemetryBackend",
    "TelemetryBackendError",
    "register_telemetry_backend",
    "get_telemetry_backend",
    "list_telemetry_backends",
    "create_telemetry_sink",
    "NullTelemetrySink",
    "InMemoryTelemetrySink",
    "OpenTelemetrySink",
    "RunMetrics",
    "RuntimeTelemetryCollector",
    "RunMetricsExporter",
    "ConsoleRunMetricsExporter",
    "JSONRunMetricsExporter",
    "JSONLRunMetricsExporter",
    "project_run_metrics_from_collector",
    "project_run_metrics_from_result",
    "run_metrics_schema_version",
]
