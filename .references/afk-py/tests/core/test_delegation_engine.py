from __future__ import annotations

import asyncio
import time

import pytest

from afk.agents.a2a import InternalA2AProtocol
from afk.agents.contracts import AgentInvocationRequest, AgentInvocationResponse
from afk.agents.delegation import (
    DelegationEdge,
    DelegationNode,
    DelegationPlan,
    RetryPolicy,
)
from afk.core.runtime import DelegationBackpressureError, DelegationEngine


def run_async(coro):
    return asyncio.run(coro)


def _request_factory(
    node: DelegationNode, payload: dict, attempt: int
) -> AgentInvocationRequest:
    return AgentInvocationRequest(
        run_id="run_1",
        thread_id="thread_1",
        conversation_id="conv_1",
        correlation_id=f"corr:{node.node_id}",
        idempotency_key=f"idem:{node.node_id}",
        causation_id="cause_1",
        source_agent="parent",
        target_agent=node.target_agent,
        payload=payload,
        metadata={"attempt": attempt},
        timeout_s=node.timeout_s,
    )


def _engine(
    *,
    global_parallel: int = 16,
    per_parent: int = 8,
    per_target: int = 4,
    backpressure: int = 512,
) -> DelegationEngine:
    return DelegationEngine(
        max_parallel_subagents_global=global_parallel,
        max_parallel_subagents_per_parent=per_parent,
        max_parallel_subagents_per_target_agent=per_target,
        subagent_queue_backpressure_limit=backpressure,
    )


def test_parallel_independent_nodes_execute_concurrently_with_deterministic_merge():
    started: dict[str, float] = {}

    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        started[request.target_agent] = time.monotonic()
        await asyncio.sleep(0.05)
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output={"agent": request.target_agent},
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(node_id="worker_b", target_agent="worker_b"),
            DelegationNode(node_id="worker_a", target_agent="worker_a"),
        ],
        max_parallelism=2,
    )

    async def scenario():
        started_at = time.monotonic()
        result, _ = await _engine(per_parent=2).execute(
            plan=plan,
            available_targets={"worker_a", "worker_b"},
            protocol=protocol,
            request_factory=_request_factory,
        )
        elapsed = time.monotonic() - started_at
        return result, elapsed

    result, elapsed = run_async(scenario())
    assert elapsed < 0.095
    assert [row.node_id for row in result.ordered_outputs] == ["worker_a", "worker_b"]
    assert result.final_status == "completed"


def test_dependent_nodes_respect_dag_order_and_bindings():
    observed_payloads: dict[str, dict] = {}

    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        observed_payloads[request.target_agent] = dict(request.payload)
        if request.target_agent == "worker_a":
            return AgentInvocationResponse(
                run_id=request.run_id,
                thread_id=request.thread_id,
                conversation_id=request.conversation_id,
                correlation_id=request.correlation_id,
                idempotency_key=request.idempotency_key,
                source_agent=request.target_agent,
                target_agent=request.source_agent,
                success=True,
                output={"value": "A-OK"},
            )
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output={"received": request.payload.get("from_a")},
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(node_id="node_a", target_agent="worker_a"),
            DelegationNode(node_id="node_b", target_agent="worker_b"),
        ],
        edges=[
            DelegationEdge(
                from_node="node_a", to_node="node_b", output_key_map={"value": "from_a"}
            )
        ],
        max_parallelism=2,
    )

    async def scenario():
        result, _ = await _engine(per_parent=2).execute(
            plan=plan,
            available_targets={"worker_a", "worker_b"},
            protocol=protocol,
            request_factory=_request_factory,
        )
        return result

    result = run_async(scenario())
    assert result.final_status == "completed"
    assert observed_payloads["worker_b"]["from_a"] == "A-OK"
    assert [row.node_id for row in result.ordered_outputs] == ["node_a", "node_b"]


def test_join_policy_allow_optional_failures_returns_degraded():
    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        if request.target_agent == "optional_worker":
            return AgentInvocationResponse(
                run_id=request.run_id,
                thread_id=request.thread_id,
                conversation_id=request.conversation_id,
                correlation_id=request.correlation_id,
                idempotency_key=request.idempotency_key,
                source_agent=request.target_agent,
                target_agent=request.source_agent,
                success=False,
                error="optional failed",
                metadata={"retryable": False},
            )
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output="ok",
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(
                node_id="required", target_agent="required_worker", required=True
            ),
            DelegationNode(
                node_id="optional", target_agent="optional_worker", required=False
            ),
        ],
        join_policy="allow_optional_failures",
        max_parallelism=2,
    )

    async def scenario():
        result, _ = await _engine(per_parent=2).execute(
            plan=plan,
            available_targets={"required_worker", "optional_worker"},
            protocol=protocol,
            request_factory=_request_factory,
        )
        return result

    result = run_async(scenario())
    assert result.final_status == "degraded"
    assert result.success_count == 1
    assert result.failure_count == 1


def test_cancel_propagation_marks_active_and_pending_nodes():
    cancel_flag = {"value": False}

    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        cancel_flag["value"] = True
        await asyncio.sleep(0.2)
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output="late",
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(node_id="a", target_agent="worker_a"),
            DelegationNode(node_id="b", target_agent="worker_b"),
        ],
        max_parallelism=1,
    )

    async def scenario():
        result, audit = await _engine(per_parent=1).execute(
            plan=plan,
            available_targets={"worker_a", "worker_b"},
            protocol=protocol,
            request_factory=_request_factory,
            cancel_requested=lambda: cancel_flag["value"],
        )
        return result, audit

    result, audit = run_async(scenario())
    assert result.final_status == "cancelled"
    assert all(row.status == "cancelled" for row in result.ordered_outputs)
    assert audit


def test_retry_and_dead_letter_on_exhausted_failures():
    attempts = {"count": 0}

    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        attempts["count"] += 1
        raise RuntimeError("transient fail")

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(
                node_id="retrying",
                target_agent="worker_a",
                retry_policy=RetryPolicy(
                    max_attempts=2, backoff_base_s=0.0, max_backoff_s=0.0
                ),
            )
        ],
        max_parallelism=1,
    )

    async def scenario():
        result, _ = await _engine().execute(
            plan=plan,
            available_targets={"worker_a"},
            protocol=protocol,
            request_factory=_request_factory,
        )
        return result

    result = run_async(scenario())
    assert attempts["count"] == 2
    row = result.node_results["retrying"]
    assert row.success is False
    assert row.attempts == 2
    assert protocol.dead_letters()


def test_backpressure_limit_is_enforced_under_high_ready_fanout():
    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        await asyncio.sleep(0.01)
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output="ok",
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)
    plan = DelegationPlan(
        nodes=[
            DelegationNode(node_id="a", target_agent="worker_a"),
            DelegationNode(node_id="b", target_agent="worker_b"),
        ],
        max_parallelism=2,
    )

    async def scenario():
        with pytest.raises(DelegationBackpressureError):
            await _engine(per_parent=2, backpressure=1).execute(
                plan=plan,
                available_targets={"worker_a", "worker_b"},
                protocol=protocol,
                request_factory=_request_factory,
            )

    run_async(scenario())
