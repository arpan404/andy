"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Shared observability data models.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..llms.types import JSONValue


@dataclass(slots=True)
class RunMetrics:
    """Aggregated run-level metrics projected from telemetry or result records."""

    run_id: str = ""
    agent_name: str = ""
    state: str = "unknown"
    total_duration_s: float = 0.0
    llm_calls: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float | None = None
    steps: int = 0
    errors: list[str] = field(default_factory=list)
    tool_latencies_ms: dict[str, list[float]] = field(default_factory=dict)
    llm_latencies_ms: list[float] = field(default_factory=list)

    @property
    def success(self) -> bool:
        """Whether run state is terminal successful completion."""

        return self.state == "completed"

    @property
    def avg_llm_latency_ms(self) -> float | None:
        """Average LLM latency in milliseconds."""

        if not self.llm_latencies_ms:
            return None
        return sum(self.llm_latencies_ms) / len(self.llm_latencies_ms)

    @property
    def avg_tool_latency_ms(self) -> float | None:
        """Average tool latency across all tools."""

        all_values = [v for rows in self.tool_latencies_ms.values() for v in rows]
        if not all_values:
            return None
        return sum(all_values) / len(all_values)

    def to_dict(self) -> dict[str, JSONValue]:
        """Serialize metrics into JSON-safe representation."""

        return {
            "run_id": self.run_id,
            "agent_name": self.agent_name,
            "state": self.state,
            "success": self.success,
            "total_duration_s": round(self.total_duration_s, 3),
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "estimated_cost_usd": self.estimated_cost_usd,
            "steps": self.steps,
            "errors": list(self.errors),
            "avg_llm_latency_ms": (
                round(self.avg_llm_latency_ms, 1) if self.avg_llm_latency_ms else None
            ),
            "avg_tool_latency_ms": (
                round(self.avg_tool_latency_ms, 1) if self.avg_tool_latency_ms else None
            ),
        }
