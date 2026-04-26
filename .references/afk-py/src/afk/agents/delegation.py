"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Delegation planning and execution result contracts.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

from ..llms.types import JSONValue

JoinPolicy = Literal[
    "all_required",
    "allow_optional_failures",
    "first_success",
    "quorum",
]

DelegationNodeStatus = Literal[
    "completed",
    "failed",
    "cancelled",
    "skipped",
    "timeout",
]

DelegationFinalStatus = Literal[
    "completed",
    "degraded",
    "failed",
    "cancelled",
]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Retry controls for one delegation node."""

    max_attempts: int = 1
    backoff_base_s: float = 0.25
    max_backoff_s: float = 5.0
    jitter_s: float = 0.0


@dataclass(frozen=True, slots=True)
class DelegationNode:
    """One executable node in a delegation plan."""

    node_id: str
    target_agent: str
    input_binding: dict[str, JSONValue] = field(default_factory=dict)
    timeout_s: float | None = 60.0
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    required: bool = True


@dataclass(frozen=True, slots=True)
class DelegationEdge:
    """Directed dependency edge between delegation nodes."""

    from_node: str
    to_node: str
    output_key_map: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DelegationPlan:
    """DAG plan for subagent fanout/fanin execution."""

    nodes: list[DelegationNode]
    edges: list[DelegationEdge] = field(default_factory=list)
    join_policy: JoinPolicy = "all_required"
    max_parallelism: int = 1
    quorum: int | None = None


@dataclass(frozen=True, slots=True)
class DelegationNodeResult:
    """Terminal execution result for one plan node."""

    node_id: str
    target_agent: str
    status: DelegationNodeStatus
    success: bool
    attempts: int = 1
    output: JSONValue | None = None
    error: str | None = None
    metadata: dict[str, JSONValue] = field(default_factory=dict)
    started_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    finished_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass(frozen=True, slots=True)
class DelegationResult:
    """Aggregated DAG execution result."""

    node_results: dict[str, DelegationNodeResult]
    ordered_outputs: list[DelegationNodeResult]
    final_status: DelegationFinalStatus
    success_count: int
    failure_count: int
