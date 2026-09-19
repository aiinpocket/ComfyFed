"""2026-09-19 job-retry: `retry.py` 的純函式與 `worker_task_failures` adapter。

上半是完全不碰 DB 的計次／門檻／訊息彙整（和 `cloud/src/core/retry.ts` 逐行
對照）；下半是 upsert／清除／TTL 查詢。派工排除與 `job_failed` 分流在
test_assess.py／test_dispatch.py／test_agent_ws.py。
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from comfyfed_server import db, metrics, retry


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --- 常數 -----------------------------------------------------------------


def test_constants_match_the_spec():
    assert retry.MAX_FAILURES_PER_WORKER_PER_JOB == 2
    assert retry.MAX_JOB_ATTEMPTS == 6
    assert retry.UNSUITABLE_THRESHOLD == 2
    assert retry.UNSUITABLE_TTL_DAYS == 7


# --- bump_attempts / is_excluded_for_job -----------------------------------


def test_bump_attempts_on_an_empty_map():
    assert retry.bump_attempts("{}", "w1") == ('{"w1": 1}', 1, 1)


def test_bump_attempts_accumulates_per_worker_and_totals():
    first, mine, total = retry.bump_attempts("{}", "w1")
    assert (mine, total) == (1, 1)
    second, mine, total = retry.bump_attempts(first, "w1")
    assert (mine, total) == (2, 2)
    third, mine, total = retry.bump_attempts(second, "w2")
    assert (mine, total) == (1, 3)
    assert json.loads(third) == {"w1": 2, "w2": 1}


def test_bump_attempts_tolerates_garbage_json():
    """一列壞掉的 attempts 不能讓 job_failed 整條路徑炸掉 -- 當成空的重算。"""
    assert retry.bump_attempts("not json", "w1") == ('{"w1": 1}', 1, 1)
    assert retry.bump_attempts("[1,2]", "w1") == ('{"w1": 1}', 1, 1)
    assert retry.bump_attempts(None, "w1") == ('{"w1": 1}', 1, 1)
    # 非數字的值也一樣：那一個 key 當 0 重新起算，其它 key 照舊。
    new_json, mine, total = retry.bump_attempts('{"w1": "x", "w2": 3}', "w1")
    assert (mine, total) == (1, 4)
    assert json.loads(new_json) == {"w1": 1, "w2": 3}


def test_is_excluded_for_job_only_at_the_threshold():
    assert retry.is_excluded_for_job("{}", "w1") is False
    once, _, _ = retry.bump_attempts("{}", "w1")
    assert retry.is_excluded_for_job(once, "w1") is False
    twice, _, _ = retry.bump_attempts(once, "w1")
    assert retry.is_excluded_for_job(twice, "w1") is True
    # 別台不受影響。
    assert retry.is_excluded_for_job(twice, "w2") is False


def test_attempts_dict_parses_defensively():
    assert retry.attempts_dict('{"w1": 2}') == {"w1": 2}
    assert retry.attempts_dict("garbage") == {}
    assert retry.attempts_dict(None) == {}


# --- summarize_final_error --------------------------------------------------


def test_summarize_final_error_is_bilingual_and_truncates_at_200():
    message = retry.summarize_final_error([("A", "boom"), ("B", "x" * 300)], 6)
    assert "已在 2 台 worker 嘗試 6 次" in message
    assert "failed on 2 workers after 6 attempts" in message
    assert "A: boom" in message
    assert "B: " + "x" * 200 in message
    assert "x" * 201 not in message
    # zh-TW 先、en 後。
    assert message.index("已在 2 台") < message.index("failed on 2 workers")


def test_summarize_final_error_joins_workers_with_the_full_width_semicolon():
    message = retry.summarize_final_error([("A", "one"), ("B", "two")], 3)
    assert "A: one；B: two" in message


def test_summarize_final_error_with_no_attempt_errors():
    message = retry.summarize_final_error([], 0)
    assert "已在 0 台 worker 嘗試 0 次" in message


# --- task_key ---------------------------------------------------------------


def test_task_key_prefers_the_signature(_db):
    job = db.Job(workflow_json="{}", signature="sig-abc")
    assert retry.task_key(job) == "sig-abc"


def test_task_key_of_a_model_fetch_job_without_a_signature(_db):
    job = db.Job(
        workflow_json="{}",
        kind="model_fetch",
        fetch_entry=json.dumps({"name": "flux1-dev.safetensors", "size_bytes": 10}),
    )
    assert retry.task_key(job) == "model_fetch:flux1-dev.safetensors"


def test_task_key_is_none_without_a_signature_or_a_fetch_entry(_db):
    assert retry.task_key(db.Job(workflow_json="{}")) is None
    assert retry.task_key(db.Job(workflow_json="{}", signature="")) is None
    # model_fetch 但 entry 壞掉／沒有 name -> 沒有 key，不記錄。
    assert retry.task_key(db.Job(workflow_json="{}", kind="model_fetch")) is None
    assert (
        retry.task_key(db.Job(workflow_json="{}", kind="model_fetch", fetch_entry="not json"))
        is None
    )
    assert (
        retry.task_key(db.Job(workflow_json="{}", kind="model_fetch", fetch_entry="{}")) is None
    )


# --- record_failure / clear_failure / active_unsuitable ---------------------


def test_record_failure_upserts_and_accumulates(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-a", "boom", "j1", now)
        session.commit()
        retry.record_failure(session, "w1", "sig-a", "boom again", "j2", now)
        session.commit()

        row = session.get(db.WorkerTaskFailure, ("w1", "sig-a"))
        assert row.failures == 2
        assert row.last_error == "boom again"
        assert row.last_job_id == "j2"
        assert row.updated_at == now


def test_record_failure_truncates_last_error_at_500(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-a", "y" * 900, "j1", now)
        session.commit()
        assert len(session.get(db.WorkerTaskFailure, ("w1", "sig-a")).last_error) == 500


def test_active_unsuitable_needs_the_threshold_and_the_ttl(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-a", "boom", "j1", now)
        session.commit()
        # 一次還不算不適任。
        assert retry.active_unsuitable(session, now) == frozenset()

        retry.record_failure(session, "w1", "sig-a", "boom", "j2", now)
        session.commit()
        assert retry.active_unsuitable(session, now) == frozenset({("w1", "sig-a")})

        # 把 updated_at 撥到 8 天前 -> 過了 TTL，不再生效（但列還在）。
        row = session.get(db.WorkerTaskFailure, ("w1", "sig-a"))
        row.updated_at = now - timedelta(days=8)
        session.commit()
        assert retry.active_unsuitable(session, now) == frozenset()
        assert session.get(db.WorkerTaskFailure, ("w1", "sig-a")) is not None


def test_clear_failure_removes_only_that_pair(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-a", "boom", "j1", now)
        retry.record_failure(session, "w1", "sig-a", "boom", "j1", now)
        retry.record_failure(session, "w2", "sig-a", "boom", "j1", now)
        retry.record_failure(session, "w2", "sig-a", "boom", "j1", now)
        session.commit()
        assert retry.active_unsuitable(session, now) == frozenset(
            {("w1", "sig-a"), ("w2", "sig-a")}
        )

        retry.clear_failure(session, "w1", "sig-a")
        session.commit()
        assert retry.active_unsuitable(session, now) == frozenset({("w2", "sig-a")})
        assert session.get(db.WorkerTaskFailure, ("w1", "sig-a")) is None


def test_clear_failure_with_no_row_is_a_noop(_db):
    with db.get_session() as session:
        retry.clear_failure(session, "nobody", "sig-a")
        retry.clear_failure(session, "nobody", None)
        session.commit()


# --- unsuitable_rows_for_worker ---------------------------------------------


def test_unsuitable_rows_for_worker_reports_active_and_inactive(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-active", "boom", "j1", now)
        retry.record_failure(session, "w1", "sig-active", "boom", "j2", now)
        # 達門檻但過期。
        retry.record_failure(session, "w1", "sig-stale", "old", "j3", now - timedelta(days=9))
        retry.record_failure(session, "w1", "sig-stale", "old", "j4", now - timedelta(days=9))
        # 未達門檻。
        retry.record_failure(session, "w1", "sig-once", "once", "j5", now)
        # 別台的列不該出現。
        retry.record_failure(session, "w2", "sig-other", "nope", "j6", now)
        session.commit()

        rows = retry.unsuitable_rows_for_worker(session, "w1", now)

    by_key = {r["task_key"]: r for r in rows}
    assert set(by_key) == {"sig-active", "sig-stale", "sig-once"}
    assert by_key["sig-active"]["active"] is True
    assert by_key["sig-active"]["failures"] == 2
    assert by_key["sig-active"]["last_error"] == "boom"
    assert by_key["sig-active"]["last_job_id"] == "j2"
    assert by_key["sig-active"]["updated_at"] == now.isoformat()
    assert by_key["sig-stale"]["active"] is False
    assert by_key["sig-once"]["active"] is False


def test_clear_worker_failures_returns_the_number_cleared(_db):
    now = _utcnow()
    with db.get_session() as session:
        retry.record_failure(session, "w1", "sig-a", "boom", "j1", now)
        retry.record_failure(session, "w1", "sig-b", "boom", "j2", now)
        retry.record_failure(session, "w2", "sig-a", "boom", "j3", now)
        session.commit()

        assert retry.clear_worker_failures(session, "w1") == 2
        session.commit()
        assert retry.unsuitable_rows_for_worker(session, "w1", now) == []
        assert len(retry.unsuitable_rows_for_worker(session, "w2", now)) == 1

        assert retry.clear_worker_failures(session, "w1") == 0
