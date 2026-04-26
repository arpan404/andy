"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Shared base queue implementation for state-backed task queues.
"""

from __future__ import annotations

import asyncio
import time
from abc import abstractmethod
from random import random

from ..llms.types import JSONValue
from .types import (
    DEAD_LETTER_REASON_KEY,
    RetryPolicy,
    TaskItem,
    TaskQueue,
)


class BaseTaskQueue(TaskQueue):
    """
    Shared task queue lifecycle logic for storage-backed implementations.

    Backends only implement task persistence and pending-ID queue primitives.
    """

    def __init__(
        self,
        *,
        retry_backoff_base_s: float = 0.0,
        retry_backoff_max_s: float = 30.0,
        retry_backoff_jitter_s: float = 0.0,
    ) -> None:
        """
        Configure retry pacing policy used for retryable failures.

        Args:
            retry_backoff_base_s: Exponential backoff base delay in seconds.
            retry_backoff_max_s: Maximum backoff delay cap in seconds.
            retry_backoff_jitter_s: Random jitter added to retry delay.
        """
        if retry_backoff_base_s < 0:
            raise ValueError("retry_backoff_base_s must be >= 0")
        if retry_backoff_max_s < 0:
            raise ValueError("retry_backoff_max_s must be >= 0")
        if retry_backoff_jitter_s < 0:
            raise ValueError("retry_backoff_jitter_s must be >= 0")
        self._retry_backoff_base_s = retry_backoff_base_s
        self._retry_backoff_max_s = retry_backoff_max_s
        self._retry_backoff_jitter_s = retry_backoff_jitter_s

    def _now(self) -> float:
        """Return wall-clock timestamp used for task lifecycle events."""
        return time.time()

    @abstractmethod
    async def _save_task(self, task: TaskItem) -> None:
        """Persist one task record."""

    @abstractmethod
    async def _load_task(self, task_id: str) -> TaskItem | None:
        """Load one task record."""

    @abstractmethod
    async def _push_pending_id(self, task_id: str) -> None:
        """Push one task ID into the pending queue."""

    @abstractmethod
    async def _pop_pending_id(self, *, timeout: float | None = None) -> str | None:
        """Pop one task ID from the pending queue."""

    @abstractmethod
    async def _delete_task(self, task_id: str) -> None:
        """Delete one task record from storage."""

    async def enqueue(self, task: TaskItem) -> TaskItem:
        """Normalize and persist a task, then push it to the pending queue."""
        task.status = "pending"
        task.error = None
        task.result = None
        task.started_at = None
        task.completed_at = None
        task.set_next_attempt_at(None)
        await self._save_task(task)
        await self._push_pending_id(task.id)
        return task

    async def dequeue(self, *, timeout: float | None = None) -> TaskItem | None:
        """
        Pop and activate the next runnable task.

        Terminal/stale task IDs in the pending queue are skipped.
        """
        deadline = None if timeout is None else time.monotonic() + max(timeout, 0.0)

        while True:
            remaining: float | None = None
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None

            task_id = await self._pop_pending_id(timeout=remaining)
            if task_id is None:
                return None

            task = await self._load_task(task_id)
            if task is None or task.is_terminal:
                continue
            now = self._now()
            next_attempt_at = task.next_attempt_at
            if next_attempt_at is not None and next_attempt_at > now:
                await self._push_pending_id(task.id)
                sleep_s = min(
                    max(0.0, next_attempt_at - now),
                    self._max_sleep_window(deadline=deadline),
                )
                if sleep_s > 0:
                    await asyncio.sleep(sleep_s)
                continue

            task.status = "running"
            task.started_at = self._now()
            task.completed_at = None
            task.set_next_attempt_at(None)
            await self._save_task(task)
            return task

    async def complete(self, task_id: str, *, result: JSONValue | None = None) -> None:
        """
        Mark one task as completed and persist its result payload.

        Terminal tasks are immutable and ignored for idempotency/safety.
        """
        task = await self._require_task(task_id)
        if task.is_terminal:
            return
        task.status = "completed"
        task.result = result
        task.error = None
        task.completed_at = self._now()
        await self._save_task(task)

    async def fail(
        self,
        task_id: str,
        *,
        error: str,
        retryable: bool = True,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        """
        Mark one task as failed, or requeue it when retry budget remains.

        When ``retryable=False``, task is moved directly to terminal ``failed``.
        Terminal tasks are immutable and ignored for idempotency/safety.
        """
        task = await self._require_task(task_id)
        if task.is_terminal:
            return
        task.retry_count += 1
        task.error = error
        task.result = None

        # `max_retries` means retries after the first failed attempt.
        if retryable and task.retry_count <= task.max_retries:
            task.status = "retrying"
            task.started_at = None
            task.completed_at = None
            policy = (
                retry_policy
                or RetryPolicy.from_metadata(task.metadata)
                or RetryPolicy(
                    backoff_base_s=self._retry_backoff_base_s,
                    backoff_max_s=self._retry_backoff_max_s,
                    backoff_jitter_s=self._retry_backoff_jitter_s,
                )
            )
            delay_s = self._compute_retry_delay_s(task.retry_count, policy=policy)
            task.set_next_attempt_at(self._now() + delay_s if delay_s > 0 else None)
            await self._save_task(task)
            await self._push_pending_id(task.id)
            return

        task.status = "failed"
        task.completed_at = self._now()
        task.set_next_attempt_at(None)
        task.metadata[DEAD_LETTER_REASON_KEY] = (
            "non_retryable_error" if not retryable else "retry_budget_exhausted"
        )
        await self._save_task(task)

    async def cancel(self, task_id: str) -> None:
        """Mark one non-terminal task as cancelled."""
        task = await self._require_task(task_id)
        if task.is_terminal:
            return
        task.status = "cancelled"
        task.completed_at = self._now()
        await self._save_task(task)

    async def get(self, task_id: str) -> TaskItem | None:
        """Return one task by id, or `None` when missing."""
        return await self._load_task(task_id)

    async def _require_task(self, task_id: str) -> TaskItem:
        """Return one task by id, raising `KeyError` when missing."""
        task = await self._load_task(task_id)
        if task is None:
            raise KeyError(f"Task '{task_id}' not found")
        return task

    def _compute_retry_delay_s(self, retry_count: int, *, policy: RetryPolicy) -> float:
        """Compute retry delay using capped exponential backoff plus jitter."""
        if policy.backoff_base_s <= 0:
            base = 0.0
        else:
            base = policy.backoff_base_s * (2 ** max(0, retry_count - 1))
        capped = min(base, policy.backoff_max_s)
        jitter = random() * policy.backoff_jitter_s
        return max(0.0, capped + jitter)

    def _max_sleep_window(self, *, deadline: float | None) -> float:
        """Bound how long dequeue sleeps while waiting for deferred retries."""
        if deadline is None:
            return 0.05
        return max(0.0, deadline - time.monotonic())

    async def redrive_dead_letters(
        self,
        *,
        limit: int = 100,
        reason: str | None = None,
    ) -> int:
        """Requeue failed dead-letter tasks back to pending."""
        moved = 0
        for task in await self.list_dead_letters(limit=limit):
            if (
                reason is not None
                and task.metadata.get(DEAD_LETTER_REASON_KEY) != reason
            ):
                continue
            task.status = "pending"
            task.error = None
            task.completed_at = None
            task.set_next_attempt_at(None)
            task.metadata.pop(DEAD_LETTER_REASON_KEY, None)
            await self._save_task(task)
            await self._push_pending_id(task.id)
            moved += 1
        return moved

    async def purge_dead_letters(
        self,
        *,
        limit: int = 100,
        reason: str | None = None,
    ) -> int:
        """Delete failed dead-letter tasks from storage."""
        removed = 0
        for task in await self.list_dead_letters(limit=limit):
            if (
                reason is not None
                and task.metadata.get(DEAD_LETTER_REASON_KEY) != reason
            ):
                continue
            await self._delete_task(task.id)
            removed += 1
        return removed
