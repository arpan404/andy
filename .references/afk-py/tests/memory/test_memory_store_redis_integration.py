from __future__ import annotations

import asyncio
import os
import uuid

import pytest

pytest.importorskip("redis", reason="redis not installed")

from afk.memory.adapters.redis import RedisMemoryStore
from afk.memory.types import LongTermMemory, MemoryEvent


def run_async(coro):
    return asyncio.run(coro)


def redis_url_from_env() -> str | None:
    explicit_url = os.getenv("AFK_REDIS_URL")
    if explicit_url:
        return explicit_url

    host = os.getenv("AFK_REDIS_HOST")
    if not host:
        return None

    port = os.getenv("AFK_REDIS_PORT", "6379")
    db = os.getenv("AFK_REDIS_DB", "0")
    password = os.getenv("AFK_REDIS_PASSWORD")
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"


def make_memory(
    mem_id: str,
    user_id: str | None,
    scope: str,
    text: str,
    updated_at: int,
    *,
    tags: list[str] | None = None,
) -> LongTermMemory:
    return LongTermMemory(
        id=mem_id,
        user_id=user_id,
        scope=scope,
        data={"text": text, "kind": "note"},
        text=text,
        tags=tags or [],
        metadata={"source": "test"},
        created_at=updated_at - 100,
        updated_at=updated_at,
    )


def make_event(event_id: str, thread_id: str, ts: int, text: str) -> MemoryEvent:
    return MemoryEvent(
        id=event_id,
        thread_id=thread_id,
        user_id="u1",
        type="message",
        timestamp=ts,
        payload={"text": text},
        tags=["chat"],
    )


def test_redis_events_recent_since_and_replace_are_chronological():
    url = redis_url_from_env()
    if url is None:
        pytest.skip("No AFK_REDIS_URL/AFK_REDIS_HOST configured for integration test")

    thread_id = f"redis-thread-{uuid.uuid4().hex}"
    store = RedisMemoryStore(url=url, events_max_per_thread=3)

    async def scenario():
        try:
            await store.setup()
        except Exception as exc:  # pragma: no cover - integration skip
            pytest.skip(f"Cannot connect to Redis at {url}: {exc}")

        try:
            await store.append_event(make_event("e1", thread_id, 1000, "one"))
            await store.append_event(make_event("e2", thread_id, 2000, "two"))
            await store.append_event(make_event("e3", thread_id, 3000, "three"))
            await store.append_event(make_event("e4", thread_id, 4000, "four"))

            recent_two = await store.get_recent_events(thread_id, limit=2)
            assert [event.id for event in recent_two] == ["e3", "e4"]

            recent_all = await store.get_recent_events(thread_id, limit=50)
            assert [event.id for event in recent_all] == ["e2", "e3", "e4"]

            since = await store.get_events_since(thread_id, since_ms=2500, limit=5)
            assert [event.id for event in since] == ["e3", "e4"]

            replacement = [
                make_event("r1", thread_id, 5000, "five"),
                make_event("r2", thread_id, 6000, "six"),
                make_event("r3", thread_id, 7000, "seven"),
                make_event("r4", thread_id, 8000, "eight"),
            ]
            await store.replace_thread_events(thread_id, replacement)
            replaced = await store.get_recent_events(thread_id, limit=10)
            assert [event.id for event in replaced] == ["r2", "r3", "r4"]
        finally:
            try:
                await store._redis().delete(store._events_key(thread_id))
            finally:
                await store.close()

    run_async(scenario())


def test_redis_capabilities_and_upsert_preserve_embedding():
    """Verify Redis reports atomic_upsert and preserves embedding when omitted."""
    url = redis_url_from_env()
    if url is None:
        pytest.skip("No AFK_REDIS_URL/AFK_REDIS_HOST configured for integration test")

    store = RedisMemoryStore(url=url)
    user_id = f"redis-user-{uuid.uuid4().hex}"
    memory_id = f"redis-memory-{uuid.uuid4().hex}"

    async def scenario():
        # If Redis not reachable, skip the test.
        try:
            await store.setup()
        except Exception as exc:  # pragma: no cover - integration skip
            pytest.skip(f"Cannot connect to Redis at {url}: {exc}")

        # capability check
        assert store.capabilities.atomic_upsert is True

        # preserve embedding behavior and user-scoped delete behavior
        original = make_memory(memory_id, user_id, "global", "Original", 1000)
        await store.upsert_long_term_memory(original, embedding=[1.0, 0.0])

        await store.delete_long_term_memory(f"{user_id}-other", memory_id)
        still_there = await store.search_long_term_memory_vector(
            user_id, [1.0, 0.0], limit=5
        )
        assert [m.id for m, _ in still_there] == [memory_id]

        updated = make_memory(memory_id, user_id, "global", "Updated", 2000)
        await store.upsert_long_term_memory(updated, embedding=None)

        vec_hits = await store.search_long_term_memory_vector(
            user_id, [1.0, 0.0], limit=5
        )
        assert [m.id for m, _ in vec_hits] == [memory_id]
        assert vec_hits[0][0].text == "Updated"

        await store.delete_long_term_memory(user_id, memory_id)
        await store.close()

    run_async(scenario())
