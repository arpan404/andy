"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Policy-related types for agent runtime decisions.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ...llms.types import JSONValue
from .common import AgentEventType, AgentState, FailurePolicy, PolicyAction


@dataclass(frozen=True, slots=True)
class AgentRunEvent:
    """
    Event emitted during agent execution lifecycle.

    Attributes:
        type: Event category (run/tool/subagent/policy/etc).
        run_id: Unique run identifier.
        thread_id: Thread identifier for memory continuity.
        state: Runtime state at event emission.
        step: Optional loop step index.
        message: Optional human-readable message.
        data: Structured event payload.
        schema_version: Event schema version string.
    """

    type: AgentEventType
    run_id: str
    thread_id: str
    state: AgentState
    step: int | None = None
    message: str | None = None
    data: dict[str, JSONValue] = field(default_factory=dict)
    schema_version: str = "v1"


@dataclass(frozen=True, slots=True)
class PolicyEvent:
    """
    Runtime policy hook payload.

    Attributes:
        event_type: Policy hook type (for example `tool_before_execute`).
        run_id: Current run identifier.
        thread_id: Current thread identifier.
        step: Current step index.
        context: JSON-safe run context snapshot.
        tool_name: Target tool name when event is tool-related.
        tool_args: JSON-safe tool arguments when relevant.
        subagent_name: Target subagent name when relevant.
        metadata: Additional runtime metadata for policy matching.
    """

    event_type: str
    run_id: str
    thread_id: str
    step: int
    context: dict[str, JSONValue]
    tool_name: str | None = None
    tool_args: dict[str, JSONValue] | None = None
    subagent_name: str | None = None
    metadata: dict[str, JSONValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    """
    Action selected by policy engine or policy roles.

    Attributes:
        action: Policy action (`allow`, `deny`, `defer`, etc).
        reason: Optional human-readable explanation.
        updated_tool_args: Optional rewritten tool args for execution.
        request_payload: Payload for approval/input defer flows.
        policy_id: Identifier of matched policy rule.
        matched_rules: Ordered list of matched rule ids.
    """

    action: PolicyAction = "allow"
    reason: str | None = None
    updated_tool_args: dict[str, JSONValue] | None = None
    request_payload: dict[str, JSONValue] = field(default_factory=dict)
    policy_id: str | None = None
    matched_rules: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class FailSafeConfig:
    """
    Runtime limits and failure-policy settings for an agent run.

    Attributes:
        llm_failure_policy: Strategy when LLM calls fail.
        tool_failure_policy: Strategy when tool calls fail.
        subagent_failure_policy: Strategy when subagent calls fail.
        approval_denial_policy: Strategy when approval is denied/timeouts.
        max_steps: Maximum run loop iterations.
        max_wall_time_s: Maximum wall-clock runtime.
        max_llm_calls: Maximum number of LLM invocations.
        max_tool_calls: Maximum number of tool invocations.
        max_parallel_tools: Max concurrent tools per batch.
        max_subagent_depth: Maximum subagent recursion depth.
        max_subagent_fanout_per_step: Maximum selected subagents per step.
        max_total_cost_usd: Optional cost ceiling for run termination.
        fallback_model_chain: Ordered fallback model list for LLM retries.
        breaker_failure_threshold: Breaker open threshold.
        breaker_cooldown_s: Breaker cooldown window in seconds.
    """

    # LLM retries + fail keeps agent resilient to transient API errors.
    llm_failure_policy: FailurePolicy = "retry_then_fail"
    # Continue on tool errors so one broken tool doesn't abort the whole run.
    tool_failure_policy: FailurePolicy = "continue_with_error"
    # Subagent failures are non-fatal; parent can still produce a result.
    subagent_failure_policy: FailurePolicy = "continue"
    # Skipping denied actions avoids blocking autonomous/headless runs.
    approval_denial_policy: FailurePolicy = "skip_action"
    # 20 steps ≈ 5–10 min of reasoning for typical workloads.
    max_steps: int = 20
    # 5 minutes wall-clock prevents runaway agents from running indefinitely.
    max_wall_time_s: float = 300.0
    # 50 LLM calls allows multi-step reasoning without unbounded cost.
    max_llm_calls: int = 50
    # 200 tool calls is generous for complex workflows but prevents loops.
    max_tool_calls: int = 200
    # 16 parallel tools balances throughput with system resource limits.
    max_parallel_tools: int = 16
    # Depth 3 prevents infinite subagent recursion while allowing delegation.
    max_subagent_depth: int = 3
    # 4 subagents per step prevents exponential fanout in parallel routing.
    max_subagent_fanout_per_step: int = 4
    # No cost ceiling by default; set this for production cost control.
    max_total_cost_usd: float | None = None
    # Empty chain: no auto-fallbacks; users add models suited to their provider.
    fallback_model_chain: list[str] = field(default_factory=list)
    # 5 consecutive failures before opening the circuit breaker.
    breaker_failure_threshold: int = 5
    # 30s cooldown before retrying after circuit breaker opens.
    breaker_cooldown_s: float = 30.0
