"""Unit tests for scheduler.py -- Phase 3.3 §2.4 成本模型的每一項、§2.5 的
Hungarian（含長方矩陣、∞、決定性）、以及兩棧共用 fixture 的黃金值。
"""

import json
import math
import pathlib
from datetime import datetime, timedelta

import pytest

from comfyfed_server import scheduler

FIXTURE_PATH = (
    pathlib.Path(__file__).resolve().parents[2] / "cloud" / "test" / "fixtures" / "scheduler_cases.json"
)


def _now():
    return datetime(2026, 9, 15, 12, 0, 0)


def _job(job_id="j1", is_light=False, models=(), created_at=None):
    return scheduler.JobCandidate(
        job_id=job_id,
        signature="sig",
        created_at=created_at or _now(),
        is_light=is_light,
        required_models=tuple(models),
    )


def _worker(worker_id="w1", backend="cuda", free_vram_gb=24.0, warm=(), inventory=()):
    return scheduler.WorkerCandidate(
        worker_id=worker_id,
        name=worker_id,
        backend=backend,
        free_vram_gb=free_vram_gb,
        warm_models=tuple(warm),
        inventory=tuple(inventory),
    )


def _pair(kind="eligible", has_warnings=False, total_fetch_bytes=0):
    return scheduler.PairVerdict(
        kind=kind, has_warnings=has_warnings, total_fetch_bytes=total_fetch_bytes
    )


# --- load_seconds ---------------------------------------------------------


def test_load_seconds_is_zero_when_every_model_is_already_warm():
    job = _job(models=("flux1-dev.safetensors",))
    worker = _worker(
        warm=("flux1-dev.safetensors",),
        inventory=({"name": "diffusion_models/flux1-dev.safetensors", "size": 22.0},),
    )
    assert scheduler.load_seconds(job, worker) == 0.0


def test_load_seconds_charges_1_5_seconds_per_gb_of_cold_models():
    job = _job(models=("flux1-dev.safetensors",))
    worker = _worker(inventory=({"name": "diffusion_models/flux1-dev.safetensors", "size": 6.0},))
    assert scheduler.load_seconds(job, worker) == pytest.approx(9.0)


def test_load_seconds_treats_an_unknown_size_as_zero():
    job = _job(models=("mystery.safetensors",))
    worker = _worker(inventory=({"name": "loras/mystery.safetensors"},))
    assert scheduler.load_seconds(job, worker) == 0.0


def test_load_seconds_sums_every_cold_model():
    job = _job(models=("a.safetensors", "b.safetensors"))
    worker = _worker(
        warm=("a.safetensors",),
        inventory=(
            {"name": "unet/a.safetensors", "size": 10.0},
            {"name": "vae/b.safetensors", "size": 2.0},
        ),
    )
    assert scheduler.load_seconds(job, worker) == pytest.approx(3.0)


# --- fetch_seconds --------------------------------------------------------


def test_fetch_seconds_is_zero_for_a_directly_eligible_pair():
    assert scheduler.fetch_seconds(_pair()) == 0.0


def test_fetch_seconds_divides_by_50_mb_per_second():
    pair = _pair(kind="eligible_after_fetch", total_fetch_bytes=500_000_000)
    assert scheduler.fetch_seconds(pair) == pytest.approx(10.0)


# --- light_penalty --------------------------------------------------------


def test_light_penalty_is_zero_for_a_heavy_job():
    assert scheduler.light_penalty(_job(is_light=False), _worker(free_vram_gb=32.0)) == 0.0


def test_light_penalty_punishes_a_real_gpu_and_scales_with_free_vram():
    # 非弱後端 60 + 32 GB * 5 = 220
    assert scheduler.light_penalty(_job(is_light=True), _worker(free_vram_gb=32.0)) == pytest.approx(220.0)


def test_light_penalty_lets_a_weak_backend_off_the_60_second_charge():
    worker = _worker(backend="mps", free_vram_gb=0.0)
    assert scheduler.light_penalty(_job(is_light=True), worker) == 0.0


# --- cost -----------------------------------------------------------------


def test_cost_sums_every_component_plus_the_legacy_tiebreak():
    job = _job(models=("flux1-dev.safetensors",))
    worker = _worker(free_vram_gb=24.0, inventory=({"name": "unet/flux1-dev.safetensors", "size": 6.0},))
    value = scheduler.cost(job, worker, _pair(), predicted_seconds=40.0, tier1_exists=True)
    # 40 (predicted) + 9 (load) + 0 (fetch) + 0 (light) + 0 (warn)
    #   + (1000 - 24)/1e6 (legacy tiebreak)
    assert value == pytest.approx(40.0 + 9.0 + 0.000976)


def test_cost_adds_a_million_for_a_warned_verdict():
    job = _job()
    worker = _worker(free_vram_gb=24.0)
    clean = scheduler.cost(job, worker, _pair(), 40.0, True)
    warned = scheduler.cost(job, worker, _pair(has_warnings=True), 40.0, True)
    assert warned - clean == pytest.approx(scheduler.WARN_PENALTY)


def test_cost_light_job_tiebreak_prefers_the_smaller_card():
    job = _job(is_light=True)
    small = scheduler.cost(job, _worker("w_small", free_vram_gb=8.0), _pair(), 40.0, True)
    big = scheduler.cost(job, _worker("w_big", free_vram_gb=8.0001), _pair(), 40.0, True)
    assert small < big


def test_cost_is_infinite_for_an_ineligible_pair():
    value = scheduler.cost(_job(), _worker(), _pair(kind="ineligible"), 40.0, True)
    assert value == math.inf


def test_cost_is_infinite_for_a_fetch_candidate_when_a_tier_1_candidate_exists():
    pair = _pair(kind="eligible_after_fetch", total_fetch_bytes=10)
    assert scheduler.cost(_job(), _worker(), pair, 40.0, tier1_exists=True) == math.inf
    assert math.isfinite(scheduler.cost(_job(), _worker(), pair, 40.0, tier1_exists=False))


def test_cost_is_infinite_when_any_component_is_nan_or_negative():
    assert scheduler.cost(_job(), _worker(), _pair(), float("nan"), True) == math.inf
    assert scheduler.cost(_job(), _worker(), _pair(), -1.0, True) == math.inf


# --- objective ------------------------------------------------------------


def test_objective_subtracts_big_so_assigning_always_beats_idling():
    assert scheduler.objective(100.0, 0.0) == pytest.approx(100.0 - scheduler.BIG)


def test_objective_rewards_waiting_one_second_per_second():
    assert scheduler.objective(100.0, 30.0) == pytest.approx(100.0 - 30.0 - scheduler.BIG)


def test_objective_adds_the_starvation_bonus_past_300_seconds():
    starved = scheduler.objective(100.0, float(scheduler.STARVE_SECONDS))
    fresh = scheduler.objective(100.0, float(scheduler.STARVE_SECONDS) - 1)
    assert fresh - starved == pytest.approx(scheduler.STARVE_BONUS + 1.0)


def test_objective_keeps_infinity_infinite():
    assert scheduler.objective(math.inf, 9999.0) == math.inf


# --- solve (Hungarian) ----------------------------------------------------


def test_solve_empty_matrix_is_empty():
    assert scheduler.solve([]) == []


def test_solve_known_optimal_4x4():
    matrix = [
        [82.0, 83.0, 69.0, 92.0],
        [77.0, 37.0, 49.0, 92.0],
        [11.0, 69.0, 5.0, 86.0],
        [8.0, 9.0, 98.0, 23.0],
    ]
    pairs = scheduler.solve(matrix)
    assert len(pairs) == 4
    assert sorted(row for row, _col in pairs) == [0, 1, 2, 3]
    assert sorted(col for _row, col in pairs) == [0, 1, 2, 3]
    # 已知最佳解成本 140（0->2, 1->1, 2->0, 3->3）。
    assert sum(matrix[row][col] for row, col in pairs) == pytest.approx(140.0)


def test_solve_rectangular_3_jobs_5_workers_avoids_forbidden_cells():
    inf = math.inf
    matrix = [
        [10.0, inf, 30.0, 40.0, 50.0],
        [inf, 20.0, 35.0, 45.0, 55.0],
        [60.0, 70.0, 15.0, 80.0, 90.0],
    ]
    assert scheduler.solve(matrix) == [(0, 0), (1, 1), (2, 2)]


def test_solve_drops_every_pair_when_the_matrix_is_all_forbidden():
    inf = math.inf
    assert scheduler.solve([[inf, inf], [inf, inf]]) == []


def test_solve_treats_nan_as_forbidden():
    nan = float("nan")
    matrix = [[nan, 5.0], [5.0, nan]]
    assert scheduler.solve(matrix) == [(0, 1), (1, 0)]


def test_solve_accepts_finite_negative_costs():
    # 目標函數刻意是負的（cost - BIG），solve 必須照收。
    matrix = [[-1e9 + 5.0, -1e9 + 50.0], [-1e9 + 40.0, -1e9 + 10.0]]
    assert scheduler.solve(matrix) == [(0, 0), (1, 1)]


def test_solve_picks_the_cheaper_rival_when_the_feasible_graph_is_deficient():
    # job 0 / job 1 只配得上 worker 0，job 2 三台都行 -- 方陣但可行圖有缺口，
    # 一定有一列配不到真實格子，正是固定哨兵會把成本量化掉的情境。
    inf = math.inf
    matrix = [
        [-1e9 + 10.0, inf, inf],
        [-1e9 + 30.0, inf, inf],
        [-1e9 + 20.0, -1e9 + 50.0, -1e9 + 60.0],
    ]
    pairs = scheduler.solve(matrix)

    assert len(pairs) == 2
    # job 2 拿得到它獨佔的其中一台（1 或 2），不會去跟人搶 worker 0。
    assert [col for row, col in pairs if row == 2][0] in (1, 2)
    # worker 0 給的是 job 0（-1e9+10）而不是比較貴的 job 1（-1e9+30）。
    assert (0, 0) in pairs
    assert pairs == [(0, 0), (2, 1)]


def test_solve_does_not_quantise_costs_when_a_row_is_all_forbidden():
    # 固定哨兵 1e18 的 ulp 是 128，這兩列的成本只差 121 -- 舊寫法會把差距抹平
    # 而選到比較貴的 (0, 1)。
    inf = math.inf
    matrix = [[inf, -1098999874.906086], [inf, -1098999996.121946]]
    assert scheduler.solve(matrix) == [(1, 1)]


def test_solve_is_deterministic_on_ties():
    matrix = [[1.0, 1.0], [1.0, 1.0]]
    first = scheduler.solve(matrix)
    assert first == scheduler.solve(matrix)
    assert first == [(0, 0), (1, 1)]


# --- match (build_matrix + solve) ----------------------------------------


def test_match_gives_two_heavy_jobs_one_card_each_instead_of_the_same_card():
    now = _now()
    jobs = [_job("j1", created_at=now), _job("j2", created_at=now)]
    workers = [_worker("w_big", free_vram_gb=32.0), _worker("w_small", free_vram_gb=12.0)]
    pairs = {(j.job_id, w.worker_id): _pair() for j in jobs for w in workers}
    predictions = {(j.job_id, w.worker_id): 40.0 for j in jobs for w in workers}

    result = scheduler.match(jobs, workers, pairs, predictions, now)

    assert len(result) == 2
    assert sorted(col for _row, col in result) == [0, 1]


def test_match_prefers_the_warm_cache_over_a_bigger_but_cold_card():
    now = _now()
    jobs = [_job("j1", models=("flux1-dev.safetensors",), created_at=now)]
    warm = _worker(
        "w_warm",
        free_vram_gb=16.0,
        warm=("flux1-dev.safetensors",),
        inventory=({"name": "unet/flux1-dev.safetensors", "size": 22.0},),
    )
    cold = _worker(
        "w_cold",
        free_vram_gb=48.0,
        inventory=({"name": "unet/flux1-dev.safetensors", "size": 22.0},),
    )
    workers = [warm, cold]
    pairs = {("j1", w.worker_id): _pair() for w in workers}
    predictions = {("j1", w.worker_id): 40.0 for w in workers}

    assert scheduler.match(jobs, workers, pairs, predictions, now) == [(0, 0)]


def test_match_prefers_the_historically_faster_worker():
    now = _now()
    jobs = [_job("j1", created_at=now)]
    workers = [_worker("w_slow", free_vram_gb=24.0), _worker("w_fast", free_vram_gb=24.0)]
    pairs = {("j1", w.worker_id): _pair() for w in workers}
    predictions = {("j1", "w_slow"): 90.0, ("j1", "w_fast"): 30.0}

    assert scheduler.match(jobs, workers, pairs, predictions, now) == [(0, 1)]


def test_match_prefers_a_clean_worker_over_a_warned_one():
    now = _now()
    jobs = [_job("j1", created_at=now)]
    workers = [_worker("w_warn", free_vram_gb=48.0), _worker("w_clean", free_vram_gb=8.0)]
    pairs = {("j1", "w_warn"): _pair(has_warnings=True), ("j1", "w_clean"): _pair()}
    predictions = {("j1", "w_warn"): 10.0, ("j1", "w_clean"): 40.0}

    assert scheduler.match(jobs, workers, pairs, predictions, now) == [(0, 1)]


def test_match_prefers_a_worker_that_already_has_the_model_over_one_that_must_download():
    now = _now()
    jobs = [_job("j1", models=("flux1-dev.safetensors",), created_at=now)]
    have = _worker("w_have", free_vram_gb=8.0, inventory=({"name": "unet/flux1-dev.safetensors", "size": 22.0},))
    fetch = _worker("w_fetch", free_vram_gb=48.0)
    workers = [have, fetch]
    pairs = {
        ("j1", "w_have"): _pair(),
        ("j1", "w_fetch"): _pair(kind="eligible_after_fetch", total_fetch_bytes=1),
    }
    predictions = {("j1", "w_have"): 40.0, ("j1", "w_fetch"): 1.0}

    assert scheduler.match(jobs, workers, pairs, predictions, now) == [(0, 0)]


def test_match_lets_a_starved_job_jump_a_fresh_one_for_the_only_worker():
    now = _now()
    starved = _job("j_old", created_at=now - timedelta(seconds=scheduler.STARVE_SECONDS + 10))
    fresh = _job("j_new", created_at=now)
    workers = [_worker("w1")]
    jobs = [fresh, starved]  # 故意把新的排前面，證明順序不是靠列表位置
    pairs = {(j.job_id, "w1"): _pair() for j in jobs}
    predictions = {(j.job_id, "w1"): 40.0 for j in jobs}

    assert scheduler.match(jobs, workers, pairs, predictions, now) == [(1, 0)]


# --- 兩棧共用 fixture ------------------------------------------------------


def test_shared_fixture_hungarian_cases_match():
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    for case in data["hungarian_cases"]:
        matrix = [[math.inf if v is None else float(v) for v in row] for row in case["matrix"]]
        expected = [tuple(pair) for pair in case["expected_pairs"]]
        assert scheduler.solve(matrix) == expected, case["name"]


def test_shared_fixture_cost_cases_match():
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    for case in data["cost_cases"]:
        job = scheduler.JobCandidate(
            job_id=case["job"]["job_id"],
            signature=case["job"]["signature"],
            created_at=datetime.fromisoformat(case["job"]["created_at"]),
            is_light=case["job"]["is_light"],
            required_models=tuple(case["job"]["required_models"]),
        )
        worker = scheduler.WorkerCandidate(
            worker_id=case["worker"]["worker_id"],
            name=case["worker"]["name"],
            backend=case["worker"]["backend"],
            free_vram_gb=case["worker"]["free_vram_gb"],
            warm_models=tuple(case["worker"]["warm_models"]),
            inventory=tuple(case["worker"]["inventory"]),
        )
        pair = scheduler.PairVerdict(
            kind=case["pair"]["kind"],
            has_warnings=case["pair"]["has_warnings"],
            total_fetch_bytes=case["pair"]["total_fetch_bytes"],
        )
        value = scheduler.cost(
            job, worker, pair, case["predicted_seconds"], case["tier1_exists"]
        )
        assert value == pytest.approx(case["expected_cost"], rel=1e-12), case["name"]
