from __future__ import annotations

import asyncio
import random

from afk.agents.a2a import InternalA2AProtocol
from afk.agents.contracts import AgentInvocationRequest, AgentInvocationResponse
from afk.agents.delegation import DelegationNode, DelegationPlan, RetryPolicy
from afk.core.runtime import DelegationEngine


class _FlakyDispatch:
    def __init__(self, fail_probability: float = 0.2) -> None:
        self.fail_probability = fail_probability

    async def __call__(
        self, request: AgentInvocationRequest
    ) -> AgentInvocationResponse:
        await asyncio.sleep(0.001)
        if random.random() < self.fail_probability:
            raise RuntimeError("transient")
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output={"node": request.target_agent},
        )


def _request_factory(node, payload, attempt):
    return AgentInvocationRequest(
        run_id="r",
        thread_id="t",
        conversation_id="c",
        correlation_id=f"{node.node_id}:{attempt}",
        idempotency_key=f"{node.node_id}",
        source_agent="parent",
        target_agent=node.target_agent,
        payload=payload,
        metadata={"attempt": attempt},
        timeout_s=node.timeout_s,
    )


async def _run_one(engine: DelegationEngine):
    protocol = InternalA2AProtocol(dispatch=_FlakyDispatch())
    plan = DelegationPlan(
        nodes=[
            DelegationNode(
                node_id=f"n{i}",
                target_agent=f"worker_{i}",
                retry_policy=RetryPolicy(
                    max_attempts=3, backoff_base_s=0.0, max_backoff_s=0.0
                ),
            )
            for i in range(8)
        ],
        max_parallelism=4,
    )

    result, _ = await engine.execute(
        plan=plan,
        available_targets={f"worker_{i}" for i in range(8)},
        protocol=protocol,
        request_factory=_request_factory,
    )
    return result


def test_delegation_engine_handles_concurrent_runs_under_flaky_conditions():
    random.seed(7)

    async def scenario():
        engine = DelegationEngine(
            max_parallel_subagents_global=64,
            max_parallel_subagents_per_parent=8,
            max_parallel_subagents_per_target_agent=8,
            subagent_queue_backpressure_limit=1024,
        )
        results = await asyncio.gather(*[_run_one(engine) for _ in range(20)])
        return results

    results = asyncio.run(scenario())
    assert len(results) == 20
    assert all(len(result.node_results) == 8 for result in results)
