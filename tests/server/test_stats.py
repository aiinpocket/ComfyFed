"""Unit tests for stats.py -- Phase 3.3 §2.3（EWMA / speed_index 更新規則）、
§2.4 的 predict basis ladder、§2.6 的回填。純函數測試不碰 DB；DB adapter 的
測試用 `_db` fixture。
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from comfyfed_server import db, metrics, stats


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _rows(*triples):
    return [stats.StatRow(worker_id=w, signature=s, ewma_seconds=e, samples=1) for w, s, e in triples]


# --- median ---------------------------------------------------------------


def test_median_of_empty_is_none():
    assert stats.median([]) is None


def test_median_odd_count_is_the_middle_value():
    assert stats.median([5.0, 1.0, 3.0]) == 3.0


def test_median_even_count_averages_the_two_middle_values():
    assert stats.median([1.0, 2.0, 3.0, 4.0]) == 2.5


# --- next_ewma ------------------------------------------------------------


def test_next_ewma_first_sample_is_the_sample_itself():
    assert stats.next_ewma(None, 42.0) == 42.0


def test_next_ewma_blends_with_alpha_0_3():
    # 0.3*20 + 0.7*10 = 13
    assert stats.next_ewma(10.0, 20.0) == pytest.approx(13.0)


# --- fleet_reference ------------------------------------------------------


def test_fleet_reference_excludes_the_reporting_worker():
    rows = _rows(("w1", "sig", 10.0), ("w2", "sig", 20.0), ("w3", "sig", 30.0))
    speed = {"w1": 1.0, "w2": 1.0, "w3": 1.0}
    assert stats.fleet_reference(rows, speed, "sig", exclude_worker_id="w1") == 25.0


def test_fleet_reference_weights_by_speed_index():
    # w2 是兩倍快，所以它的 10 秒等於「平均機」的 20 秒。
    rows = _rows(("w2", "sig", 10.0))
    assert stats.fleet_reference(rows, {"w2": 2.0}, "sig", exclude_worker_id="w1") == 20.0


def test_fleet_reference_is_none_when_nobody_else_has_data():
    rows = _rows(("w1", "sig", 10.0))
    assert stats.fleet_reference(rows, {"w1": 1.0}, "sig", exclude_worker_id="w1") is None


def test_fleet_reference_ignores_other_signatures():
    rows = _rows(("w2", "other", 10.0))
    assert stats.fleet_reference(rows, {"w2": 1.0}, "sig", exclude_worker_id="w1") is None


# --- next_speed_index -----------------------------------------------------


def test_next_speed_index_unchanged_without_a_reference():
    assert stats.next_speed_index(1.0, None, 10.0) == 1.0


def test_next_speed_index_rises_when_faster_than_the_fleet():
    # ratio = 20/10 = 2；0.3*2 + 0.7*1 = 1.3
    assert stats.next_speed_index(1.0, 20.0, 10.0) == pytest.approx(1.3)


def test_next_speed_index_falls_when_slower_than_the_fleet():
    # ratio = 10/20 = 0.5；0.3*0.5 + 0.7*1 = 0.85
    assert stats.next_speed_index(1.0, 10.0, 20.0) == pytest.approx(0.85)


def test_next_speed_index_clamps_to_the_bounds():
    assert stats.next_speed_index(10.0, 1e9, 1.0) == stats.SPEED_MAX
    assert stats.next_speed_index(0.1, 1.0, 1e9) == stats.SPEED_MIN


def test_next_speed_index_unchanged_when_exec_is_zero():
    # 除以 0 不能炸，也不能產生 inf -- 直接維持原值。
    assert stats.next_speed_index(1.0, 20.0, 0.0) == 1.0


# --- predict basis ladder (§2.4) -----------------------------------------


def test_predict_uses_this_workers_own_row_first():
    rows = _rows(("w1", "sig", 41.2), ("w2", "sig", 80.0))
    seconds, basis = stats.predict(rows, {"w1": 1.0, "w2": 1.0}, "sig", "w1")
    assert (seconds, basis) == (41.2, "signature")


def test_predict_falls_back_to_the_fleet_reference_scaled_by_speed_index():
    rows = _rows(("w2", "sig", 40.0))
    seconds, basis = stats.predict(rows, {"w1": 2.0, "w2": 1.0}, "sig", "w1")
    assert basis == "speed_index"
    assert seconds == pytest.approx(20.0)  # R(sig)=40 / speed_index 2.0


def test_predict_falls_back_to_the_fleet_median_of_every_signature():
    rows = _rows(("w2", "other-a", 10.0), ("w2", "other-b", 30.0))
    seconds, basis = stats.predict(rows, {"w1": 1.0, "w2": 1.0}, "sig", "w1")
    assert basis == "fleet_default"
    assert seconds == pytest.approx(20.0)  # median(10, 30) / 1.0


def test_predict_falls_back_to_sixty_seconds_with_no_data_at_all():
    assert stats.predict([], {}, "sig", "w1") == (stats.DEFAULT_PREDICTED_SECONDS, "none")


def test_predict_with_a_null_signature_skips_the_signature_rungs():
    rows = _rows(("w2", "other", 30.0))
    seconds, basis = stats.predict(rows, {"w1": 1.0, "w2": 1.0}, None, "w1")
    assert basis == "fleet_default"
    assert seconds == pytest.approx(30.0)


# --- record_completion (DB adapter) --------------------------------------


def _make_worker(worker_id, speed_index=1.0):
    with db.get_session() as session:
        session.add(db.Worker(id=worker_id, name=worker_id, pubkey="pk", speed_index=speed_index))
        session.commit()
    return worker_id


def test_record_completion_inserts_the_first_row(_db):
    _make_worker("w1")
    stats.record_completion("w1", "sig", 30.0)
    with db.get_session() as session:
        row = session.get(db.WorkerJobStats, ("w1", "sig"))
        assert row.ewma_seconds == 30.0
        assert row.samples == 1
        assert session.get(db.Worker, "w1").speed_index == 1.0  # 沒有別人，不更新


def test_record_completion_blends_an_existing_row(_db):
    _make_worker("w1")
    stats.record_completion("w1", "sig", 10.0)
    stats.record_completion("w1", "sig", 20.0)
    with db.get_session() as session:
        row = session.get(db.WorkerJobStats, ("w1", "sig"))
        assert row.ewma_seconds == pytest.approx(13.0)
        assert row.samples == 2


def test_record_completion_updates_speed_index_against_the_other_workers(_db):
    _make_worker("w1")
    _make_worker("w2")
    stats.record_completion("w2", "sig", 20.0)
    stats.record_completion("w1", "sig", 10.0)  # ratio = 20/10 = 2 -> 1.3
    with db.get_session() as session:
        assert session.get(db.Worker, "w1").speed_index == pytest.approx(1.3)
        assert session.get(db.Worker, "w2").speed_index == 1.0


def test_record_completion_ignores_a_missing_signature_or_exec(_db):
    _make_worker("w1")
    stats.record_completion("w1", None, 30.0)
    stats.record_completion("w1", "sig", None)
    stats.record_completion("w1", "sig", float("nan"))
    stats.record_completion("w1", "sig", -1.0)
    with db.get_session() as session:
        assert session.query(db.WorkerJobStats).count() == 0


def test_record_completion_swallows_db_errors(_db, monkeypatch):
    """統計更新失敗只記 log，不能讓 job_done/收據流程掛掉（spec §5）。"""
    _make_worker("w1")

    def _boom():
        raise RuntimeError("db is on fire")

    monkeypatch.setattr(db, "get_session", _boom)
    stats.record_completion("w1", "sig", 30.0)  # 不得拋出


# --- backfill (§2.6) ------------------------------------------------------


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def test_backfill_replays_completed_receipts_and_sets_the_flag(_db):
    _make_worker("w1")
    workflow = {"1": {"class_type": "KSampler", "inputs": {"steps": 20}}}
    base = _utcnow()
    with db.get_session() as session:
        for i in range(2):
            session.add(
                db.Job(
                    id=f"j{i}",
                    workflow_json=json.dumps(workflow),
                    status="done",
                    required_models="[]",
                    created_at=base + timedelta(seconds=i),
                )
            )
            session.add(
                db.Receipt(
                    id=f"r{i}",
                    job_id=f"j{i}",
                    worker_id="w1",
                    gpu_seconds=10.0 * (i + 1),
                    platform_sig="sig",
                    kind="completed",
                    billable=True,
                    created_at=base + timedelta(seconds=i),
                )
            )
        session.commit()

    assert stats.backfill_if_needed() is True

    with db.get_session() as session:
        job_sig = session.get(db.Job, "j0").signature
        assert job_sig is not None  # 簽章缺的 job 由 workflow_json 補算並寫回
        row = session.get(db.WorkerJobStats, ("w1", job_sig))
        # 10 先進、20 後進：0.3*20 + 0.7*10 = 13
        assert row.ewma_seconds == pytest.approx(13.0)
        assert row.samples == 2

    # 第二次呼叫是 no-op（旗標已設）。
    assert stats.backfill_if_needed() is False


def test_backfill_skips_non_billable_and_failed_receipts(_db):
    _make_worker("w1")
    with db.get_session() as session:
        session.add(db.Job(id="j0", workflow_json="{}", status="failed", required_models="[]"))
        session.add(
            db.Receipt(
                id="r0", job_id="j0", worker_id="w1", gpu_seconds=10.0,
                platform_sig="sig", kind="failed", billable=False,
            )
        )
        session.commit()

    assert stats.backfill_if_needed() is True
    with db.get_session() as session:
        assert session.query(db.WorkerJobStats).count() == 0


# --- Final-review I3: 批次回填 = N 次順序 record_completion -----------------


_REPLAY = [
    ("w1", "sigA", 10.0),
    ("w2", "sigA", 20.0),
    ("w1", "sigB", 5.0),
    ("w1", "sigA", 30.0),
    ("w2", "sigB", 7.0),
    ("w2", "sigA", 12.0),
    ("w1", "sigA", 9.0),
    ("w3", "sigA", 40.0),
]


def _seed_receipts(triples):
    """One done job + one completed billable receipt per triple, `created_at`
    strictly increasing so the oldest-first replay order is unambiguous."""
    base = _utcnow()
    with db.get_session() as session:
        for index, (worker_id, signature, gpu_seconds) in enumerate(triples):
            session.add(
                db.Job(
                    id=f"j{index}",
                    workflow_json="{}",
                    status="done",
                    signature=signature,
                    required_models="[]",
                    created_at=base + timedelta(seconds=index),
                )
            )
            session.add(
                db.Receipt(
                    id=f"r{index}",
                    job_id=f"j{index}",
                    worker_id=worker_id,
                    gpu_seconds=gpu_seconds,
                    platform_sig="sig",
                    kind="completed",
                    billable=True,
                    created_at=base + timedelta(seconds=index),
                )
            )
        session.commit()


def _numeric_snapshot():
    """Flat `name -> float` view of everything the replay is allowed to touch."""
    out = {}
    with db.get_session() as session:
        for row in session.query(db.WorkerJobStats).all():
            out[f"ewma:{row.worker_id}:{row.signature}"] = row.ewma_seconds
            out[f"samples:{row.worker_id}:{row.signature}"] = float(row.samples)
        for worker in session.query(db.Worker).all():
            out[f"speed:{worker.id}"] = worker.speed_index
    return out


def test_backfill_matches_n_sequential_record_completion_calls(_db, tmp_path):
    """Final-review I3：回填改成「讀一次 -> 記憶體重放 -> 寫一次」之後，結果
    必須和一筆一筆呼叫 `record_completion` 完全相同（同樣的快照時點、同樣的
    排除自己規則、同樣的 EWMA 與 speed_index 演進）。
    """
    db.init_db(str(tmp_path / "backfilled.db"))
    for worker_id in ("w1", "w2", "w3"):
        _make_worker(worker_id)
    _seed_receipts(_REPLAY)
    assert stats.backfill_if_needed() is True
    batched = _numeric_snapshot()

    db.init_db(str(tmp_path / "sequential.db"))
    for worker_id in ("w1", "w2", "w3"):
        _make_worker(worker_id)
    for worker_id, signature, gpu_seconds in _REPLAY:
        stats.record_completion(worker_id, signature, gpu_seconds)
    sequential = _numeric_snapshot()

    assert sorted(batched) == sorted(sequential)
    assert batched == pytest.approx(sequential)
    # 而且真的有東西被算出來（不是兩邊都是空的）。
    assert batched["samples:w1:sigA"] == 3.0
    assert batched["speed:w1"] != 1.0


def test_backfill_leaves_the_flag_unset_when_the_write_fails(_db, monkeypatch):
    """Final-review I3：旗標只在寫入成功之後才設。寫入炸掉 -> 旗標不設 ->
    下一次啟動會完整重試一次。"""
    _make_worker("w1")
    _seed_receipts(_REPLAY[:3])

    def _boom(session, stats_map, speed_updates):
        raise RuntimeError("write blew up")

    monkeypatch.setattr(stats, "_apply_backfill_writes", _boom)

    assert stats.backfill_if_needed() is False

    with db.get_session() as session:
        assert session.get(db.Setting, stats.BACKFILL_SETTING_KEY) is None
        assert session.query(db.WorkerJobStats).count() == 0

    # 旗標沒設，所以下一次（寫入恢復正常）會真的跑完。
    monkeypatch.undo()
    assert stats.backfill_if_needed() is True
    with db.get_session() as session:
        assert session.get(db.Setting, stats.BACKFILL_SETTING_KEY).value == "1"
        assert session.query(db.WorkerJobStats).count() > 0
