"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Single-case eval execution helpers.
"""

from __future__ import annotations

import asyncio
import inspect

from ..core.runner import Runner
from ..observability.projectors import project_run_metrics_from_result
from .budgets import EvalBudget, evaluate_budget
from .contracts import AsyncEvalAssertion, EvalAssertion, EvalScorer
from .models import EvalAssertionResult, EvalCase, EvalCaseResult


async def arun_case(
    runner: Runner,
    case: EvalCase,
    *,
    assertions: tuple[EvalAssertion | AsyncEvalAssertion, ...] = (),
    scorers: tuple[EvalScorer, ...] = (),
    budget: EvalBudget | None = None,
) -> EvalCaseResult:
    """Run one eval case asynchronously and return case result envelope."""

    handle = await runner.run_handle(
        case.agent,
        user_message=case.user_message,
        context=case.context,
        thread_id=case.thread_id,
    )
    event_types: list[str] = []
    async for event in handle.events:
        event_types.append(event.type)

    result = await handle.await_result()
    if result is None:
        raise RuntimeError(f"Eval case '{case.name}' cancelled")

    metrics = project_run_metrics_from_result(result)
    budget_to_apply = case.budget or budget
    budget_violations = evaluate_budget(metrics, budget_to_apply)
    assertion_rows: list[EvalAssertionResult] = []
    for assertion in assertions:
        outcome = assertion(
            case,
            EvalCaseResult(
                case=case.name,
                state=result.state,
                final_text=result.final_text,
                run_id=result.run_id,
                thread_id=result.thread_id,
                event_types=event_types,
                metrics=metrics,
                assertions=[],
                budget_violations=[],
                passed=result.state == "completed",
            ),
        )
        if inspect.isawaitable(outcome):
            outcome = await outcome
        assertion_rows.append(outcome)
    for scorer in scorers:
        assertion_rows.append(
            EvalAssertionResult(
                name=f"score:{scorer.name}",
                passed=True,
                score=float(
                    scorer(
                        case,
                        EvalCaseResult(
                            case=case.name,
                            state=result.state,
                            final_text=result.final_text,
                            run_id=result.run_id,
                            thread_id=result.thread_id,
                            event_types=event_types,
                            metrics=metrics,
                            assertions=[],
                            budget_violations=[],
                            passed=result.state == "completed",
                        ),
                    )
                ),
            )
        )
    passed = (
        result.state == "completed"
        and not budget_violations
        and all(row.passed for row in assertion_rows)
    )
    return EvalCaseResult(
        case=case.name,
        state=result.state,
        final_text=result.final_text,
        run_id=result.run_id,
        thread_id=result.thread_id,
        event_types=event_types,
        metrics=metrics,
        assertions=assertion_rows,
        budget_violations=budget_violations,
        passed=passed,
    )


def run_case(
    runner: Runner,
    case: EvalCase,
    *,
    assertions: tuple[EvalAssertion | AsyncEvalAssertion, ...] = (),
    scorers: tuple[EvalScorer, ...] = (),
    budget: EvalBudget | None = None,
) -> EvalCaseResult:
    """Run one eval case synchronously using a dedicated event loop."""

    return asyncio.run(
        arun_case(
            runner,
            case,
            assertions=assertions,
            scorers=scorers,
            budget=budget,
        )
    )
