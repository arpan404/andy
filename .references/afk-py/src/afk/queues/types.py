"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Task queue types and abstract base.
"""

from __future__ import annotations

import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from ..llms.types import JSONValue
from .contracts import EXECUTION_CONTRACT_KEY

# ---------------------------------------------------------------------------
# Task types
# ---------------------------------------------------------------------------

NEXT_ATTEMPT_AT_KEY = "next_attempt_at"
DEAD_LETTER_REASON_KEY = "dead_letter_reason"
RETRY_BACKOFF_BASE_KEY = "retry_backoff_base_s"
RETRY_BACKOFF_MAX_KEY = "retry_backoff_max_s"
RETRY_BACKOFF_JITTER_KEY = "retry_backoff_jitter_s"

TaskStatus = Literal[
    "pending", "running", "completed", "failed", "retrying", "cancelled"
]


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Retry backoff policy used to schedule deferred retry attempts."""

    backoff_base_s: float = 0.0
    backoff_max_s: float = 30.0
    backoff_jitter_s: float = 0.0

    def as_metadata(self) -> dict[str, JSONValue]:
        """Serialize retry policy into task metadata fields."""
        return {
            RETRY_BACKOFF_BASE_KEY: self.backoff_base_s,
            RETRY_BACKOFF_MAX_KEY: self.backoff_max_s,
            RETRY_BACKOFF_JITTER_KEY: self.backoff_jitter_s,
        }

    @classmethod
    def from_metadata(cls, metadata: dict[str, JSONValue]) -> RetryPolicy | None:
        """Parse retry policy from metadata fields when fully specified."""
        base = metadata.get(RETRY_BACKOFF_BASE_KEY)
        max_s = metadata.get(RETRY_BACKOFF_MAX_KEY)
        jitter = metadata.get(RETRY_BACKOFF_JITTER_KEY)
        values = (base, max_s, jitter)
        if all(isinstance(v, (int, float)) for v in values):
            return cls(
                backoff_base_s=float(base),  # type: ignore[arg-type]
                backoff_max_s=float(max_s),  # type: ignore[arg-type]
                backoff_jitter_s=float(jitter),  # type: ignore[arg-type]
            )
        return None


@dataclass(slots=True)
class TaskItem:
    """
    A unit of work in the task queue.

    Attributes:
        id: Unique task identifier.
        agent_name: Agent to execute this task (optional for non-agent contracts).
        payload: Contract-specific task input data.
        status: Current task lifecycle status.
        result: Task output after completion.
        error: Error message on failure.
        retry_count: Number of times this task has been retried.
        max_retries: Maximum allowed retries before permanent failure.
        created_at: Unix timestamp when task was enqueued.
        started_at: Unix timestamp when execution began.
        completed_at: Unix timestamp when task reached terminal state.
        metadata: Optional JSON-safe metadata.
    """

    agent_name: str | None
    payload: dict[str, JSONValue]
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: TaskStatus = "pending"
    result: JSONValue | None = None
    error: str | None = None
    retry_count: int = 0
    max_retries: int = 3
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    completed_at: float | None = None
    metadata: dict[str, JSONValue] = field(default_factory=dict)

    @property
    def is_terminal(self) -> bool:
        """Whether the task has reached a terminal state."""
        return self.status in ("completed", "failed", "cancelled")

    @property
    def duration_s(self) -> float | None:
        """Execution duration in seconds, or None if not started/completed."""
        if self.started_at is not None and self.completed_at is not None:
            return self.completed_at - self.started_at
        return None

    @property
    def execution_contract(self) -> str | None:
        """
        Return execution contract id from metadata, if present and valid.
        """
        value = self.metadata.get(EXECUTION_CONTRACT_KEY)
        if isinstance(value, str) and value.strip():
            return value
        return None

    def set_execution_contract(self, contract_id: str) -> None:
        """Persist execution contract id in task metadata."""
        self.metadata[EXECUTION_CONTRACT_KEY] = contract_id

    @property
    def next_attempt_at(self) -> float | None:
        """Return deferred-retry timestamp from metadata, when present."""
        value = self.metadata.get(NEXT_ATTEMPT_AT_KEY)
        if isinstance(value, (int, float)):
            return float(value)
        return None

    def set_next_attempt_at(self, ts: float | None) -> None:
        """Set or clear deferred-retry timestamp metadata."""
        if ts is None:
            self.metadata.pop(NEXT_ATTEMPT_AT_KEY, None)
            return
        self.metadata[NEXT_ATTEMPT_AT_KEY] = float(ts)


# ---------------------------------------------------------------------------
# Queue abstract base
# ---------------------------------------------------------------------------


class TaskQueue(ABC):
    """
    Abstract task queue for distributed agent work.

    Implementations provide the persistence layer (in-memory, Redis, etc.).
    """

    @abstractmethod
    async def enqueue(self, task: TaskItem) -> TaskItem:
        """
        Add a task to the queue.

        Args:
            task: Task to enqueue.

        Returns:
            The enqueued task (may have updated fields).
        """
        ...

    @abstractmethod
    async def dequeue(self, *, timeout: float | None = None) -> TaskItem | None:
        """
        Remove and return the next pending task.

        Args:
            timeout: Max seconds to wait. ``None`` = wait forever.

        Returns:
            Next task, or ``None`` on timeout.
        """
        ...

    @abstractmethod
    async def complete(self, task_id: str, *, result: JSONValue | None = None) -> None:
        """
        Mark a task as completed.

        Args:
            task_id: Task identifier.
            result: Optional result payload.
        """
        ...

    @abstractmethod
    async def fail(
        self,
        task_id: str,
        *,
        error: str,
        retryable: bool = True,
        retry_policy: RetryPolicy | None = None,
    ) -> None:
        """
        Mark a task as failed.

        If retry_count <= max_retries after increment, the task is
        re-enqueued with status ``retrying``. Otherwise the task moves to
        ``failed``.

        Args:
            task_id: Task identifier.
            error: Error message.
            retryable: When False, force terminal failure without retry.
            retry_policy: Optional retry backoff override for this failure.
        """
        ...

    @abstractmethod
    async def cancel(self, task_id: str) -> None:
        """
        Cancel a pending or running task.

        Args:
            task_id: Task identifier.
        """
        ...

    @abstractmethod
    async def get(self, task_id: str) -> TaskItem | None:
        """
        Retrieve a task by ID.

        Returns:
            Task item, or ``None`` if not found.
        """
        ...

    @abstractmethod
    async def list_tasks(
        self,
        *,
        status: TaskStatus | None = None,
        limit: int = 100,
    ) -> list[TaskItem]:
        """
        List tasks with optional status filter.

        Args:
            status: Filter by task status.
            limit: Max number of tasks to return.

        Returns:
            List of matching tasks.
        """
        ...

    async def enqueue_contract(
        self,
        execution_contract: str,
        payload: dict[str, JSONValue],
        *,
        agent_name: str | None = None,
        max_retries: int = 3,
        metadata: dict[str, JSONValue] | None = None,
        retry_policy: RetryPolicy | None = None,
    ) -> TaskItem:
        """
        Enqueue a task with an explicit execution contract.

        Args:
            execution_contract: Contract id consumed by TaskWorker.
            payload: Contract-specific input payload.
            agent_name: Optional agent identifier (required by some contracts).
            max_retries: Maximum retry attempts for retryable failures.
            metadata: Optional JSON-safe metadata map.
            retry_policy: Optional per-task retry policy override.
        """
        contract_id = execution_contract.strip()
        if not contract_id:
            raise ValueError("execution_contract must be a non-empty string")

        task_metadata = dict(metadata or {})
        task_metadata[EXECUTION_CONTRACT_KEY] = contract_id
        if retry_policy is not None:
            task_metadata.update(retry_policy.as_metadata())
        task = TaskItem(
            agent_name=agent_name,
            payload=dict(payload),
            max_retries=max_retries,
            metadata=task_metadata,
        )
        return await self.enqueue(task)

    async def list_dead_letters(self, *, limit: int = 100) -> list[TaskItem]:
        """
        Return dead-lettered tasks.

        Default implementation maps DLQ to terminal failed tasks.
        """
        return await self.list_tasks(status="failed", limit=limit)

    async def redrive_dead_letters(
        self,
        *,
        limit: int = 100,
        reason: str | None = None,
    ) -> int:
        """Requeue failed dead-letter tasks back to pending."""
        _ = reason
        _ = limit
        raise NotImplementedError("dead-letter redrive is not supported by this queue")

    async def purge_dead_letters(
        self,
        *,
        limit: int = 100,
        reason: str | None = None,
    ) -> int:
        """Delete failed dead-letter tasks from storage."""
        _ = reason
        _ = limit
        raise NotImplementedError("dead-letter purge is not supported by this queue")


@runtime_checkable
class WorkerPresenceCapable(Protocol):
    """
    Optional queue capability for tracking active workers with TTL semantics.
    """

    async def register_worker(self, worker_id: str, *, ttl_s: float) -> None:
        """Register one worker as active."""

    async def refresh_worker(self, worker_id: str, *, ttl_s: float) -> None:
        """Refresh worker presence TTL."""

    async def unregister_worker(self, worker_id: str) -> None:
        """Remove one worker from active presence tracking."""


@runtime_checkable
class StartupRecoveryCapable(Protocol):
    """
    Optional queue capability for startup in-flight recovery.
    """

    async def recover_inflight_if_idle(self, *, active_worker_id: str) -> int:
        """Requeue in-flight tasks when this worker is the only active worker."""
