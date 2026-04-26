"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Projection helpers that convert telemetry/result records into RunMetrics.
"""

from __future__ import annotations

import time
from typing import Any

from ...agents.types import AgentResult
from .. import contracts
from ..collectors.runtime import RuntimeTelemetryCollector
from ..models import RunMetrics

_SCHEMA_VERSION = "run_metrics.v1"


def run_metrics_schema_version() -> str:
    """Return stable run-metrics schema version identifier."""

    return _SCHEMA_VERSION


def project_run_metrics_from_collector(
    collector: RuntimeTelemetryCollector,
) -> RunMetrics:
    """Project run metrics from runtime telemetry records."""

    metrics = RunMetrics()
    now_s = time.time()
    metrics.total_duration_s = max(0.0, now_s - collector.started_at())

    counters = collector.counters()
    histograms = collector.histograms()
    spans = collector.spans()

    metrics.llm_calls = _counter_total(counters, contracts.METRIC_AGENT_LLM_CALLS_TOTAL)
    metrics.tool_calls = _counter_total(
        counters,
        contracts.METRIC_AGENT_TOOL_CALLS_TOTAL,
    )

    for row in histograms:
        name = row.get("name")
        value = _to_float(row.get("value"))
        attrs = row.get("attributes") if isinstance(row.get("attributes"), dict) else {}
        if value is None:
            continue
        if name == contracts.METRIC_AGENT_LLM_LATENCY_MS:
            metrics.llm_latencies_ms.append(value)
        if name == contracts.METRIC_AGENT_TOOL_CALL_LATENCY_MS:
            tool_name = str(attrs.get("tool_name", "unknown"))
            metrics.tool_latencies_ms.setdefault(tool_name, []).append(value)

    run_span = _latest_run_span(spans)
    if run_span is not None:
        attrs = run_span.get("attributes")
        attr_map = attrs if isinstance(attrs, dict) else {}
        metrics.run_id = _to_str(attr_map.get("run_id"))
        metrics.agent_name = _to_str(attr_map.get("agent_name"))
        metrics.state = _to_str(attr_map.get("state"), default="unknown")
        metrics.steps = _to_int(attr_map.get("steps"))
        metrics.input_tokens = _to_int(attr_map.get("input_tokens"))
        metrics.output_tokens = _to_int(attr_map.get("output_tokens"))
        metrics.total_tokens = _to_int(attr_map.get("total_tokens"))
        cost = _to_float(attr_map.get("total_cost_usd"))
        metrics.estimated_cost_usd = cost

        duration_ms = _to_float(run_span.get("duration_ms"))
        if duration_ms is not None:
            metrics.total_duration_s = max(0.0, duration_ms / 1000.0)

    errors: list[str] = []
    for span in spans:
        if str(span.get("status")) == "error":
            err = span.get("error")
            if isinstance(err, str) and err:
                errors.append(err)
    for event in collector.events():
        if event.name == contracts.AGENT_RUN_EVENT:
            event_type = event.attributes.get("event_type")
            if event_type == "run_failed":
                msg = event.attributes.get("message")
                if isinstance(msg, str) and msg:
                    errors.append(msg)
    metrics.errors = errors

    return metrics


def project_run_metrics_from_result(result: AgentResult) -> RunMetrics:
    """Project run metrics from terminal AgentResult records."""

    snapshot = result.state_snapshot if isinstance(result.state_snapshot, dict) else {}
    metrics = RunMetrics(
        run_id=result.run_id,
        state=result.state,
        llm_calls=_to_int(snapshot.get("llm_calls")),
        tool_calls=len(result.tool_executions),
        input_tokens=result.usage_aggregate.input_tokens,
        output_tokens=result.usage_aggregate.output_tokens,
        total_tokens=result.usage_aggregate.total_tokens,
        estimated_cost_usd=result.total_cost_usd,
        steps=_to_int(snapshot.get("step")),
    )
    for tool_exec in result.tool_executions:
        if tool_exec.latency_ms is not None:
            metrics.tool_latencies_ms.setdefault(tool_exec.tool_name, []).append(
                float(tool_exec.latency_ms)
            )
        if tool_exec.error:
            metrics.errors.append(f"tool:{tool_exec.tool_name}: {tool_exec.error}")

    started_at_s = _to_float(snapshot.get("started_at_s"))
    if started_at_s is not None:
        metrics.total_duration_s = max(0.0, time.time() - started_at_s)

    return metrics


def _counter_total(rows: list[dict[str, Any]], name: str) -> int:
    total = 0
    for row in rows:
        if row.get("name") == name:
            total += _to_int(row.get("value"))
    return total


def _latest_run_span(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    selected: dict[str, Any] | None = None
    selected_ended = -1.0
    for row in rows:
        if row.get("name") != contracts.SPAN_AGENT_RUN:
            continue
        ended = _to_float(row.get("ended_at_ms"))
        if ended is None:
            ended = -1.0
        if selected is None or ended > selected_ended:
            selected = row
            selected_ended = ended
    return selected


def _to_int(value: Any, *, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _to_float(value: Any, *, default: float | None = None) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def _to_str(value: Any, *, default: str = "") -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return default
    return str(value)
