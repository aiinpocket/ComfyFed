"""Prometheus metrics: a fresh registry per app instance, wired into the
agent WebSocket heartbeat/handshake and job dispatch lifecycle events.

Uses a dedicated `CollectorRegistry` per `Metrics` instance rather than
prometheus_client's global default registry, because tests build multiple
apps (hence multiple `Metrics` instances) in the same process and
prometheus_client raises if the same metric name is registered twice on one
registry.

agentws/dispatch are module-level-style code (no app instance is threaded
through them), so they reach the current app's metrics via `get_metrics()`,
a module-level singleton set by `init()` (called once per `create_app`).
"""

from __future__ import annotations

import logging
import math
from typing import Optional

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from prometheus_client.core import GaugeMetricFamily

from . import db

logger = logging.getLogger(__name__)

_METRICS_PUBLIC_KEY = "metrics_public"

# Wide, minute/hour-scale buckets: render jobs commonly queue and run for
# minutes, so the prometheus_client default buckets (all <= 10s) would put
# every observation in the last bucket and be useless for dashboards/alerts.
_JOB_WAIT_BUCKETS = (1, 5, 15, 60, 300, 900, 3600)
_JOB_RUN_BUCKETS = (5, 30, 60, 180, 600, 1800, 3600, 7200)


class _QueuedJobsCollector:
    """Custom collector: queries the DB for the current queued-job count at
    scrape time instead of being updated incrementally from every call site
    that can change it (submission, dispatch, requeue, ...) — querying fresh
    on each scrape is simpler and can't drift out of sync with the DB."""

    def collect(self):
        family = GaugeMetricFamily("comfyfed_jobs_queued", "Number of jobs currently queued.")
        with db.get_session() as session:
            count = session.query(db.Job).filter(db.Job.status == "queued").count()
        family.add_metric([], count)
        yield family


class Metrics:
    """One process/app's set of Prometheus metric objects, on their own
    registry.

    Worker label uses the worker's NAME, not its id: dashboards (e.g.
    Grafana) group and filter by this label, and an operator recognizes a
    worker by the name they gave it, not its opaque UUID. The id remains the
    DB primary key for anything that needs it.
    """

    def __init__(self) -> None:
        self.registry = CollectorRegistry()

        self.worker_up = Gauge(
            "comfyfed_worker_up",
            "1 if the worker is connected (online/busy/paused), 0 if offline.",
            ["worker"],
            registry=self.registry,
        )
        self.worker_free_vram_gb = Gauge(
            "comfyfed_worker_free_vram_gb",
            "Free VRAM in GB, from the worker's last heartbeat.",
            ["worker"],
            registry=self.registry,
        )
        self.worker_free_ram_gb = Gauge(
            "comfyfed_worker_free_ram_gb",
            "Free system RAM in GB, from the worker's last heartbeat.",
            ["worker"],
            registry=self.registry,
        )
        self.worker_free_disk_gb = Gauge(
            "comfyfed_worker_free_disk_gb",
            "Free disk space in GB, from the worker's last heartbeat.",
            ["worker"],
            registry=self.registry,
        )
        self.job_wait_seconds = Histogram(
            "comfyfed_job_wait_seconds",
            "Seconds a job waited in queue before it started running.",
            buckets=_JOB_WAIT_BUCKETS,
            registry=self.registry,
        )
        self.job_run_seconds = Histogram(
            "comfyfed_job_run_seconds",
            "Seconds a job spent running, from start to done/failed.",
            buckets=_JOB_RUN_BUCKETS,
            registry=self.registry,
        )
        self.ws_reconnects_total = Counter(
            "comfyfed_ws_reconnects_total",
            "Count of successful agent WebSocket handshakes, per worker.",
            ["worker"],
            registry=self.registry,
        )
        self.registry.register(_QueuedJobsCollector())

    def set_worker_dynamic(self, worker_name: str, dynamic: dict) -> None:
        """Update the free-{vram,ram,disk} gauges from a heartbeat's
        `dynamic` payload, leaving a gauge unset (not zeroed) when the
        worker's heartbeat doesn't report that field.

        `dynamic` is worker-supplied and untrusted: a garbage/non-numeric
        value must not raise and disconnect the worker's WS, so each value is
        coerced to a finite float and silently skipped (logged) otherwise.
        """
        self._set_one(self.worker_free_vram_gb, worker_name, dynamic.get("free_vram_gb"))
        self._set_one(self.worker_free_ram_gb, worker_name, dynamic.get("free_ram_gb"))
        self._set_one(self.worker_free_disk_gb, worker_name, dynamic.get("free_disk_gb"))

    @staticmethod
    def _set_one(gauge: Gauge, worker_name: str, raw_value: object) -> None:
        if raw_value is None:
            return
        try:
            value = float(raw_value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            logger.warning("metrics: ignoring non-numeric dynamic value %r for worker %s", raw_value, worker_name)
            return
        if not math.isfinite(value):
            logger.warning("metrics: ignoring non-finite dynamic value %r for worker %s", raw_value, worker_name)
            return
        gauge.labels(worker=worker_name).set(value)


_current: Optional[Metrics] = None


def init() -> Metrics:
    """Create a fresh `Metrics` (and its own registry) and install it as the
    current instance. Called once per `create_app`, so each app/test process
    gets isolated metric state instead of colliding on a shared registry."""
    global _current
    _current = Metrics()
    return _current


def get_metrics() -> Metrics:
    if _current is None:
        raise RuntimeError("Metrics not initialized: call metrics.init() first (create_app does this).")
    return _current


def is_public(session) -> bool:
    """Whether GET /metrics should be reachable without admin auth.

    Defaults to true (public) when the `metrics_public` setting is unset;
    stored as the strings 'true'/'false' like other boolean settings here.
    """
    row = session.get(db.Setting, _METRICS_PUBLIC_KEY)
    if row is None:
        return True
    return row.value != "false"
