"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

JSON exporter for run metrics envelopes.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from ..models import RunMetrics
from ..projectors.run_metrics import run_metrics_schema_version


class JSONRunMetricsExporter:
    """Export one run metrics envelope as formatted JSON."""

    def __init__(self, *, path: str | Path | None = None, indent: int = 2) -> None:
        self._path = Path(path) if path is not None else None
        self._indent = indent
        self._last_output: str | None = None

    def export(self, metrics: RunMetrics) -> None:
        payload = {
            "schema_version": run_metrics_schema_version(),
            "reported_at": time.time(),
            "metrics": metrics.to_dict(),
        }
        output = json.dumps(payload, indent=self._indent, ensure_ascii=True)
        self._last_output = output
        if self._path is None:
            print(output)
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(output + "\n", encoding="utf-8")

    @property
    def last_output(self) -> str | None:
        """Return last exported JSON payload string."""

        return self._last_output
