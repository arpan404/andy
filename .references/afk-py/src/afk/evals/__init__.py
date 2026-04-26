"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Public eval APIs for case/suite execution and deterministic trace assertions.
"""

from .assertions import (
    EventTypesExactAssertion,
    FinalTextContainsAssertion,
    ResultLengthScorer,
    StateCompletedAssertion,
)
from .budgets import EvalBudget, evaluate_budget
from .contracts import AsyncEvalAssertion, EvalAssertion, EvalScorer
from .datasets import load_eval_cases_json
from .executor import arun_case, run_case
from .golden import compare_event_types, write_golden_trace
from .models import (
    EvalAssertionResult,
    EvalCase,
    EvalCaseResult,
    EvalSuiteConfig,
    EvalSuiteResult,
    ExecutionMode,
)
from .reporting import suite_report_payload, write_suite_report_json
from .suite import arun_suite, run_suite

__all__ = [
    "ExecutionMode",
    "EvalBudget",
    "EvalCase",
    "EvalCaseResult",
    "EvalAssertionResult",
    "EvalSuiteConfig",
    "EvalSuiteResult",
    "run_case",
    "arun_case",
    "run_suite",
    "arun_suite",
    "compare_event_types",
    "write_golden_trace",
    "load_eval_cases_json",
    "EvalAssertion",
    "AsyncEvalAssertion",
    "EvalScorer",
    "StateCompletedAssertion",
    "FinalTextContainsAssertion",
    "EventTypesExactAssertion",
    "ResultLengthScorer",
    "evaluate_budget",
    "suite_report_payload",
    "write_suite_report_json",
]
