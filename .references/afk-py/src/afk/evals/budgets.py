"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Budget constraints and evaluators for eval case metrics.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..observability.models import RunMetrics


@dataclass(frozen=True, slots=True)
class EvalBudget:
    """Hard limits applied to one eval case's projected run metrics."""

    max_duration_s: float | None = None
    max_total_tokens: int | None = None
    max_total_cost_usd: float | None = None


def evaluate_budget(metrics: RunMetrics, budget: EvalBudget | None) -> list[str]:
    """Return budget violation messages for one metrics payload."""

    if budget is None:
        return []

    violations: list[str] = []
    if (
        budget.max_duration_s is not None
        and metrics.total_duration_s > budget.max_duration_s
    ):
        violations.append(
            f"duration_s={metrics.total_duration_s:.4f} exceeded max_duration_s={budget.max_duration_s:.4f}"
        )
    if (
        budget.max_total_tokens is not None
        and metrics.total_tokens > budget.max_total_tokens
    ):
        violations.append(
            f"total_tokens={metrics.total_tokens} exceeded max_total_tokens={budget.max_total_tokens}"
        )
    if (
        budget.max_total_cost_usd is not None
        and metrics.estimated_cost_usd is not None
        and metrics.estimated_cost_usd > budget.max_total_cost_usd
    ):
        violations.append(
            "total_cost_usd="
            f"{metrics.estimated_cost_usd:.6f} exceeded max_total_cost_usd={budget.max_total_cost_usd:.6f}"
        )
    return violations
