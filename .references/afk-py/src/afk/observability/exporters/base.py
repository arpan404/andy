"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Base exporter protocol for run metrics reports.
"""

from __future__ import annotations

from typing import Protocol

from ..models import RunMetrics


class RunMetricsExporter(Protocol):
    """Exporter protocol for run metrics outputs."""

    def export(self, metrics: RunMetrics) -> None:
        """Persist or display one run metrics payload."""
        ...
