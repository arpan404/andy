"""
MIT License
Copyright (c) 2026 arpan404
See LICENSE file for full license text.

Metrics adapters for queue worker observability.
"""

from __future__ import annotations

from collections.abc import Mapping

from .worker import WorkerMetrics


class PrometheusWorkerMetrics(WorkerMetrics):
    """
    Prometheus-backed worker metrics adapter.

    Requires `prometheus_client` package.
    """

    def __init__(self, *, namespace: str = "afk") -> None:
        try:
            from prometheus_client import Counter
        except ModuleNotFoundError as exc:  # pragma: no cover
            raise RuntimeError(
                "PrometheusWorkerMetrics requires `prometheus_client` to be installed."
            ) from exc

        self._Counter = Counter
        self._namespace = namespace
        self._counters: dict[str, object] = {}

    def incr(
        self, name: str, value: int = 1, *, tags: Mapping[str, str] | None = None
    ) -> None:
        label_names = tuple(sorted((tags or {}).keys()))
        key = f"{name}|{','.join(label_names)}"
        counter = self._counters.get(key)
        if counter is None:
            counter = self._Counter(
                name=name,
                documentation=f"AFK queue metric {name}",
                namespace=self._namespace,
                labelnames=label_names,
            )
            self._counters[key] = counter

        if label_names:
            label_values = [str((tags or {})[label]) for label in label_names]
            counter.labels(*label_values).inc(value)
        else:
            counter.inc(value)
