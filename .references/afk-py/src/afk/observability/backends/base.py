"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Backend protocol for pluggable telemetry sink providers.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from ...core.telemetry import TelemetrySink
from ...llms.types import JSONValue


class TelemetryBackend(Protocol):
    """Provider contract used to construct telemetry sinks."""

    backend_id: str

    def create_sink(
        self,
        *,
        config: Mapping[str, JSONValue] | None = None,
    ) -> TelemetrySink:
        """Create one telemetry sink instance from backend config."""
        ...
