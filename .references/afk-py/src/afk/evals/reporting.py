"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Report serialization helpers for eval suite outputs.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .models import EvalSuiteResult


def suite_report_payload(suite: EvalSuiteResult) -> dict[str, object]:
    """Build stable JSON envelope for eval suite results."""

    return {
        "schema_version": "eval_suite.v1",
        "reported_at": time.time(),
        "summary": {
            "execution_mode": suite.execution_mode,
            "total": suite.total,
            "passed": suite.passed,
            "failed": suite.failed,
        },
        "results": [
            {
                "case": row.case,
                "state": row.state,
                "run_id": row.run_id,
                "thread_id": row.thread_id,
                "event_types": row.event_types,
                "passed": row.passed,
                "budget_violations": row.budget_violations,
                "assertions": [
                    {
                        "name": assertion.name,
                        "passed": assertion.passed,
                        "details": assertion.details,
                        "score": assertion.score,
                    }
                    for assertion in row.assertions
                ],
                "metrics": row.metrics.to_dict(),
            }
            for row in suite.results
        ],
    }


def write_suite_report_json(path: str | Path, suite: EvalSuiteResult) -> None:
    """Persist eval suite JSON report payload to disk."""

    payload = suite_report_payload(suite)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8"
    )
