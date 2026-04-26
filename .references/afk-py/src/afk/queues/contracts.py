"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Execution contract primitives for task worker dispatch.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from ..agents import BaseAgent
from ..llms.types import JSONValue

if TYPE_CHECKING:
    from .types import TaskItem

EXECUTION_CONTRACT_KEY = "execution_contract"
RUNNER_CHAT_CONTRACT = "runner.chat.v1"
JOB_DISPATCH_CONTRACT = "job.dispatch.v1"


class ExecutionContractError(RuntimeError):
    """Base execution contract error."""


class ExecutionContractResolutionError(ExecutionContractError):
    """Raised when a task cannot be mapped to a known execution contract."""


class ExecutionContractValidationError(ExecutionContractError):
    """Raised when task data is invalid for a resolved execution contract."""


class JobHandler(Protocol):
    """Callable handler used by ``job.dispatch.v1`` contract."""

    def __call__(
        self,
        arguments: dict[str, JSONValue],
        *,
        task_item: TaskItem,
    ) -> JSONValue | Awaitable[JSONValue]: ...


@dataclass(slots=True)
class ExecutionContractContext:
    """
    Shared worker dependencies passed to execution contracts.

    Attributes:
        job_handlers: Named handler map used by dispatch-style contracts.
    """

    job_handlers: Mapping[str, JobHandler] = field(default_factory=dict)


class ExecutionContract(Protocol):
    """Contract protocol implemented by worker execution strategies."""

    contract_id: str
    requires_agent: bool

    async def execute(
        self,
        task_item: TaskItem,
        *,
        agent: BaseAgent | None,
        worker_context: ExecutionContractContext,
    ) -> JSONValue:
        """Execute one task and return JSON-safe output payload."""


class RunnerChatExecutionContract:
    """
    Built-in contract for runner-based agent execution.

    Expected payload schema:
    - user_message: str | None
    - context: dict[str, JSONValue] | None
    """

    contract_id = RUNNER_CHAT_CONTRACT
    requires_agent = True

    def __init__(self, *, runner_factory: Callable[[], Any] | None = None) -> None:
        self._runner_factory = runner_factory

    def _create_runner(self) -> Any:
        if self._runner_factory:
            return self._runner_factory()
        from ..core.runner import Runner

        return Runner()

    async def execute(
        self,
        task_item: TaskItem,
        *,
        agent: BaseAgent | None,
        worker_context: ExecutionContractContext,
    ) -> JSONValue:
        if agent is None:
            raise ExecutionContractValidationError(
                f"Contract '{self.contract_id}' requires an agent"
            )

        payload = task_item.payload
        user_message = payload.get("user_message")
        if user_message is not None and not isinstance(user_message, str):
            raise ExecutionContractValidationError(
                f"Contract '{self.contract_id}' expected payload.user_message to be str | None"
            )

        context = payload.get("context")
        if context is not None and not isinstance(context, dict):
            raise ExecutionContractValidationError(
                f"Contract '{self.contract_id}' expected payload.context to be dict | None"
            )

        runner = self._create_runner()
        result = await runner.run(
            agent,
            user_message=user_message,
            context=dict(context) if isinstance(context, dict) else None,
        )
        return {"final_text": result.final_text, "state": result.state}


class JobDispatchExecutionContract:
    """
    Built-in contract for non-agent job execution via registered handlers.

    Expected payload schema:
    - job_type: str
    - arguments: dict[str, JSONValue] (optional, defaults to empty dict)
    """

    contract_id = JOB_DISPATCH_CONTRACT
    requires_agent = False

    async def execute(
        self,
        task_item: TaskItem,
        *,
        agent: BaseAgent | None,
        worker_context: ExecutionContractContext,
    ) -> JSONValue:
        _ = agent
        payload = task_item.payload

        job_type = payload.get("job_type")
        if not isinstance(job_type, str) or not job_type.strip():
            raise ExecutionContractValidationError(
                f"Contract '{self.contract_id}' requires non-empty payload.job_type"
            )

        arguments = payload.get("arguments", {})
        if not isinstance(arguments, dict):
            raise ExecutionContractValidationError(
                f"Contract '{self.contract_id}' expected payload.arguments to be dict"
            )

        handler = worker_context.job_handlers.get(job_type)
        if handler is None:
            raise ExecutionContractValidationError(
                f"Unknown job handler '{job_type}' for contract '{self.contract_id}'"
            )

        result = handler(arguments, task_item=task_item)
        if inspect.isawaitable(result):
            return await result
        return result
