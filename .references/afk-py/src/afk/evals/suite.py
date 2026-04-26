"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Suite-level eval execution orchestration.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from ..core.runner import Runner
from .budgets import EvalBudget
from .contracts import AsyncEvalAssertion, EvalAssertion, EvalScorer
from .executor import arun_case
from .models import (
    EvalCase,
    EvalCaseResult,
    EvalSuiteConfig,
    EvalSuiteResult,
    ExecutionMode,
)


async def arun_suite(
    *,
    runner_factory: Callable[[], Runner],
    cases: list[EvalCase],
    config: EvalSuiteConfig | None = None,
) -> EvalSuiteResult:
    """Run eval cases with deterministic ordering and configurable execution mode."""

    cfg = config or EvalSuiteConfig()
    mode = _resolve_execution_mode(
        cfg.execution_mode, case_count=len(cases), max_concurrency=cfg.max_concurrency
    )

    if mode == "sequential":
        results = await _run_sequential(
            runner_factory=runner_factory,
            cases=cases,
            fail_fast=cfg.fail_fast,
            assertions=cfg.assertions,
            scorers=cfg.scorers,
            budget=cfg.budget,
        )
    else:
        results = await _run_parallel(
            runner_factory=runner_factory,
            cases=cases,
            max_concurrency=max(1, cfg.max_concurrency),
            fail_fast=cfg.fail_fast,
            assertions=cfg.assertions,
            scorers=cfg.scorers,
            budget=cfg.budget,
        )

    return EvalSuiteResult(results=results, execution_mode=mode)


def run_suite(
    *,
    runner_factory: Callable[[], Runner],
    cases: list[EvalCase],
    config: EvalSuiteConfig | None = None,
) -> EvalSuiteResult:
    """Sync wrapper for suite execution."""

    return asyncio.run(
        arun_suite(runner_factory=runner_factory, cases=cases, config=config)
    )


async def _run_sequential(
    *,
    runner_factory: Callable[[], Runner],
    cases: list[EvalCase],
    fail_fast: bool,
    assertions: tuple[EvalAssertion | AsyncEvalAssertion, ...],
    scorers: tuple[EvalScorer, ...],
    budget: EvalBudget | None,
) -> list[EvalCaseResult]:
    out: list[EvalCaseResult] = []
    for case in cases:
        row = await arun_case(
            runner_factory(),
            case,
            assertions=assertions,
            scorers=scorers,
            budget=budget,
        )
        out.append(row)
        if fail_fast and not row.passed:
            break
    return out


async def _run_parallel(
    *,
    runner_factory: Callable[[], Runner],
    cases: list[EvalCase],
    max_concurrency: int,
    fail_fast: bool,
    assertions: tuple[EvalAssertion | AsyncEvalAssertion, ...],
    scorers: tuple[EvalScorer, ...],
    budget: EvalBudget | None,
) -> list[EvalCaseResult]:
    semaphore = asyncio.Semaphore(max_concurrency)
    stop = asyncio.Event()
    rows: list[EvalCaseResult | None] = [None] * len(cases)

    async def _one(index: int, case: EvalCase) -> None:
        if stop.is_set():
            return
        async with semaphore:
            if stop.is_set():
                return
            row = await arun_case(
                runner_factory(),
                case,
                assertions=assertions,
                scorers=scorers,
                budget=budget,
            )
            rows[index] = row
            if fail_fast and not row.passed:
                stop.set()

    tasks = [asyncio.create_task(_one(i, case)) for i, case in enumerate(cases)]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    return [row for row in rows if row is not None]


def _resolve_execution_mode(
    requested: ExecutionMode,
    *,
    case_count: int,
    max_concurrency: int,
) -> ExecutionMode:
    if requested != "adaptive":
        return requested
    if case_count <= 2 or max_concurrency <= 1:
        return "sequential"
    return "parallel"
