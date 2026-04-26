"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Console exporter for human-readable metrics reports.
"""

from __future__ import annotations

import sys
from typing import TextIO

from ..models import RunMetrics


class ConsoleRunMetricsExporter:
    """Pretty-print one run metrics summary to console output."""

    def __init__(self, *, output: TextIO | None = None, color: bool = True) -> None:
        self._output = output or sys.stdout
        self._color = color

    def _c(self, text: str, code: str) -> str:
        if not self._color:
            return text
        return f"\033[{code}m{text}\033[0m"

    def export(self, metrics: RunMetrics) -> None:
        out = self._output
        header = self._c("═" * 50, "36")
        out.write(f"\n{header}\n")
        out.write(self._c("  AFK Run Metrics\n", "1;36"))
        out.write(f"{header}\n\n")

        status = (
            self._c("SUCCESS", "32") if metrics.success else self._c("FAILED", "31")
        )
        out.write(f"  Status:    {status}\n")
        if metrics.agent_name:
            out.write(f"  Agent:     {metrics.agent_name}\n")
        if metrics.run_id:
            out.write(f"  Run ID:    {metrics.run_id[:16]}...\n")
        out.write(f"  Duration:  {metrics.total_duration_s:.2f}s\n")
        out.write(f"  Steps:     {metrics.steps}\n")
        out.write(f"  LLM calls: {metrics.llm_calls}\n")
        out.write(f"  Tool calls:{metrics.tool_calls}\n")

        if metrics.estimated_cost_usd is not None:
            out.write(
                f"  Cost:      {self._c(f'${metrics.estimated_cost_usd:.4f}', '33')}\n"
            )

        if metrics.errors:
            out.write(self._c(f"  Errors ({len(metrics.errors)}):\n", "31"))
            for err in metrics.errors[:5]:
                out.write(f"  - {err[:100]}\n")

        out.write(f"\n{header}\n")
        out.flush()
