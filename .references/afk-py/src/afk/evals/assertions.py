"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Built-in eval assertions and scorer adapters.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import EvalAssertionResult, EvalCase, EvalCaseResult


@dataclass(frozen=True, slots=True)
class StateCompletedAssertion:
    """Pass only when eval case reaches completed terminal state."""

    name: str = "state_completed"

    def __call__(self, case: EvalCase, result: EvalCaseResult) -> EvalAssertionResult:
        _ = case
        ok = result.state == "completed"
        return EvalAssertionResult(
            name=self.name,
            passed=ok,
            details=None if ok else f"state={result.state}",
        )


@dataclass(frozen=True, slots=True)
class FinalTextContainsAssertion:
    """Pass only when final text contains required substring."""

    needle: str
    name: str = "final_text_contains"

    def __call__(self, case: EvalCase, result: EvalCaseResult) -> EvalAssertionResult:
        _ = case
        ok = self.needle in result.final_text
        return EvalAssertionResult(
            name=self.name,
            passed=ok,
            details=None if ok else f"missing_substring={self.needle}",
        )


@dataclass(frozen=True, slots=True)
class EventTypesExactAssertion:
    """Pass only when event types exactly match expected sequence."""

    expected: tuple[str, ...]
    name: str = "event_types_exact"

    def __call__(self, case: EvalCase, result: EvalCaseResult) -> EvalAssertionResult:
        _ = case
        observed = tuple(result.event_types)
        ok = observed == self.expected
        return EvalAssertionResult(
            name=self.name,
            passed=ok,
            details=None if ok else f"expected={self.expected} observed={observed}",
        )


@dataclass(frozen=True, slots=True)
class ResultLengthScorer:
    """Simple scorer that returns final text length as float score."""

    name: str = "result_length"

    def __call__(self, case: EvalCase, result: EvalCaseResult) -> float:
        _ = case
        return float(len(result.final_text))
