from __future__ import annotations

import io
import json
from concurrent.futures import ThreadPoolExecutor

from afk.observability import RunMetrics
from afk.observability.exporters import (
    ConsoleRunMetricsExporter,
    JSONLRunMetricsExporter,
    JSONRunMetricsExporter,
)


def test_json_exporter_writes_schema_envelope(tmp_path):
    path = tmp_path / "metrics.json"
    exporter = JSONRunMetricsExporter(path=path)
    exporter.export(RunMetrics(run_id="run_1", state="completed", llm_calls=2))

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "run_metrics.v1"
    assert payload["metrics"]["run_id"] == "run_1"


def test_jsonl_exporter_is_append_only(tmp_path):
    path = tmp_path / "metrics.jsonl"
    exporter = JSONLRunMetricsExporter(path)

    def _emit(i: int) -> None:
        exporter.export(RunMetrics(run_id=f"run_{i}", state="completed"))

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(_emit, range(12)))

    rows = exporter.read_all()
    assert len(rows) == 12


def test_console_exporter_writes_human_output():
    buf = io.StringIO()
    exporter = ConsoleRunMetricsExporter(output=buf, color=False)
    exporter.export(RunMetrics(run_id="run_1", state="completed", llm_calls=1))
    text = buf.getvalue()
    assert "AFK Run Metrics" in text
    assert "run_1" in text
