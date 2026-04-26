from __future__ import annotations

import asyncio

from afk.agents.a2a import GoogleA2AProtocolAdapter
from afk.agents.contracts import AgentInvocationRequest


def run_async(coro):
    return asyncio.run(coro)


class _FakeClient:
    async def send_message(self, request):
        return {"success": True, "output": {"echo": request.payload}}

    async def send_message_streaming(self, request):
        async def _iter():
            yield {"success": True, "output": {"chunk": 1}}
            yield {"success": True, "output": {"chunk": 2}}

        return _iter()

    async def get_task(self, task_id: str):
        return {"task_id": task_id, "status": "running"}

    async def cancel_task(self, task_id: str):
        return {"task_id": task_id, "status": "cancelled"}


def _request() -> AgentInvocationRequest:
    return AgentInvocationRequest(
        run_id="r1",
        thread_id="t1",
        conversation_id="c1",
        correlation_id="corr1",
        idempotency_key="idem1",
        source_agent="parent",
        target_agent="child",
        payload={"k": "v"},
    )


def test_google_adapter_invoke_and_task_operations():
    adapter = GoogleA2AProtocolAdapter(client=_FakeClient())

    async def scenario():
        response = await adapter.invoke(_request())
        task = await adapter.get_task("task-1")
        cancel = await adapter.cancel_task("task-1")
        return response, task, cancel

    response, task, cancel = run_async(scenario())
    assert response.success is True
    assert response.output == {"echo": {"k": "v"}}
    assert task["status"] == "running"
    assert cancel["status"] == "cancelled"


def test_google_adapter_stream_maps_events():
    adapter = GoogleA2AProtocolAdapter(client=_FakeClient())

    async def scenario():
        event_types = []
        async for event in adapter.invoke_stream(_request()):
            event_types.append(event.type)
        return event_types

    event_types = run_async(scenario())
    assert event_types == ["completed", "completed"]
