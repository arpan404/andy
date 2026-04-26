from __future__ import annotations

import asyncio

from afk.agents.a2a import InternalA2AProtocol
from afk.agents.contracts import AgentInvocationRequest, AgentInvocationResponse


def run_async(coro):
    return asyncio.run(coro)


def _request() -> AgentInvocationRequest:
    return AgentInvocationRequest(
        run_id="run_1",
        thread_id="thread_1",
        conversation_id="conv_1",
        correlation_id="corr_1",
        idempotency_key="idem_1",
        causation_id="cause_1",
        source_agent="parent",
        target_agent="child",
        payload={"k": "v"},
    )


def test_protocol_dedupes_same_idempotency_key_after_success():
    calls = {"count": 0}

    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        calls["count"] += 1
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output={"ok": True},
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)

    async def scenario():
        first = await protocol.invoke(_request())
        second = await protocol.invoke(_request())
        return first, second

    first, second = run_async(scenario())
    assert calls["count"] == 1
    assert first.success is True
    assert second.success is True
    assert any(event.type == "ignored_late_response" for event in protocol.events())


def test_protocol_stream_emits_typed_delivery_events():
    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        return AgentInvocationResponse(
            run_id=request.run_id,
            thread_id=request.thread_id,
            conversation_id=request.conversation_id,
            correlation_id=request.correlation_id,
            idempotency_key=request.idempotency_key,
            source_agent=request.target_agent,
            target_agent=request.source_agent,
            success=True,
            output="done",
        )

    protocol = InternalA2AProtocol(dispatch=dispatch)

    async def scenario():
        event_types = []
        async for event in protocol.invoke_stream(_request()):
            event_types.append(event.type)
        return event_types

    events = run_async(scenario())
    assert events[:2] == ["queued", "dispatched"]
    assert "acked" in events
    assert events[-1] == "completed"


def test_protocol_records_dead_letter_entries():
    async def dispatch(request: AgentInvocationRequest) -> AgentInvocationResponse:
        _ = request
        raise RuntimeError("boom")

    protocol = InternalA2AProtocol(dispatch=dispatch)

    async def scenario():
        await protocol.record_dead_letter(_request(), error="boom", attempts=3)

    run_async(scenario())
    dead_letters = protocol.dead_letters()
    assert len(dead_letters) == 1
    assert dead_letters[0].attempts == 3
    assert any(event.type == "dead_letter" for event in protocol.events())
