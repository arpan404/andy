#!/usr/bin/env python3
"""
Queue benchmark utility for throughput/latency characterization.

Usage examples:
  PYTHONPATH=src python scripts/queue_benchmark.py --backend inmemory
  PYTHONPATH=src python scripts/queue_benchmark.py --backend redis --redis-url redis://localhost:6379/0
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
import uuid

from afk.queues import (
    ExecutionContractContext,
    InMemoryTaskQueue,
    RedisTaskQueue,
    TaskItem,
    TaskWorker,
    TaskWorkerConfig,
)


class SleepContract:
    contract_id = "bench.sleep.v1"
    requires_agent = False

    def __init__(self, latency_ms: float) -> None:
        self._latency_s = latency_ms / 1000.0

    async def execute(
        self,
        task_item: TaskItem,
        *,
        agent,
        worker_context: ExecutionContractContext,
    ):
        _ = task_item
        _ = agent
        _ = worker_context
        await asyncio.sleep(self._latency_s)
        return {"ok": True}


async def run_benchmark(
    *,
    backend: str,
    num_tasks: int,
    concurrency: int,
    latency_ms: float,
    redis_url: str | None,
) -> None:
    if backend == "inmemory":
        queue = InMemoryTaskQueue()
    elif backend == "redis":
        if not redis_url:
            raise ValueError("--redis-url is required for redis backend")
        import redis.asyncio as redis

        client = redis.Redis.from_url(redis_url)
        queue = RedisTaskQueue(client, prefix=f"bench:{uuid.uuid4().hex}")
    else:
        raise ValueError(f"Unsupported backend: {backend}")

    contract = SleepContract(latency_ms=latency_ms)
    completed_latencies: list[float] = []
    completed = 0
    completion_event = asyncio.Event()

    async def on_complete(task: TaskItem) -> None:
        nonlocal completed
        if task.duration_s is not None:
            completed_latencies.append(task.duration_s)
        completed += 1
        if completed >= num_tasks:
            completion_event.set()

    worker = TaskWorker(
        queue,
        agents={},
        execution_contracts={"bench.sleep.v1": contract},
        config=TaskWorkerConfig(max_concurrent_tasks=concurrency, poll_interval_s=0.01),
        on_complete=on_complete,
    )

    started = time.time()
    await worker.start()
    for _ in range(num_tasks):
        await queue.enqueue_contract("bench.sleep.v1", payload={}, agent_name=None)

    await asyncio.wait_for(completion_event.wait(), timeout=120)
    elapsed = time.time() - started
    await worker.shutdown()

    throughput = num_tasks / elapsed if elapsed > 0 else 0.0
    p50 = statistics.median(completed_latencies) if completed_latencies else 0.0
    p95 = (
        sorted(completed_latencies)[int(0.95 * (len(completed_latencies) - 1))]
        if completed_latencies
        else 0.0
    )

    print(f"backend={backend}")
    print(f"tasks={num_tasks}")
    print(f"concurrency={concurrency}")
    print(f"contract_latency_ms={latency_ms:.2f}")
    print(f"elapsed_s={elapsed:.3f}")
    print(f"throughput_tps={throughput:.2f}")
    print(f"task_duration_p50_ms={p50 * 1000:.2f}")
    print(f"task_duration_p95_ms={p95 * 1000:.2f}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Queue benchmark utility")
    parser.add_argument("--backend", choices=("inmemory", "redis"), default="inmemory")
    parser.add_argument("--num-tasks", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--latency-ms", type=float, default=10.0)
    parser.add_argument("--redis-url", type=str, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    asyncio.run(
        run_benchmark(
            backend=args.backend,
            num_tasks=args.num_tasks,
            concurrency=args.concurrency,
            latency_ms=args.latency_ms,
            redis_url=args.redis_url,
        )
    )


if __name__ == "__main__":
    main()
