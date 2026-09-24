# Phase 3.3 排程優化與批次拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 派工從「逐 job 貪婪比 free VRAM」升級成「學過每台 worker 跑每種圖有多快、考慮模型熱快取與下載成本、整體 Hungarian 配對」，並且讓一張 `batch_size≥2` 的圖自動拆成多個子 job 同時落在多台 worker 上。

**Architecture:** 新增四個純函數模組（兩棧各一份、行為逐項對齊）：`assess.signature` 算工作簽章、`stats` 累積 `(worker, signature)` 的 EWMA 與 `speed_index`、`scheduler` 算成本矩陣並以 Kuhn–Munkres 求最小成本配對、`split` 判定可拆／重寫子 workflow／由子 job 推導父 job 狀態。派工 tick 先做拆分決策再做整體配對；`job_done` 回饋執行秒數給 `stats`。父 job 對面板與 console 是唯一可見的單位，子 job 只在 console 的 `?include_children=1` 與詳細頁子表出現。

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy 2.x / Alembic（`server/`）；Cloudflare Workers / Hono / D1 / Durable Object（`cloud/`）；React 18 + Mantine + i18next（`web/`）；pytest、vitest（`cloud/`、`web/`）。

**Spec:** `docs/superpowers/specs/2026-09-15-scheduler-and-batch-split-design.md` — 具約束力的唯一權威，每個任務開工前都要重讀對應章節。上游規格 `docs/superpowers/specs/2026-09-12-comfyfed-spec.md`（§7 任務生命週期、收據定義）。

## Global Constraints

- 兩棧 parity（Python 與 cloud 行為逐項對齊，同一 fixture 同一結果）。
- agent 不改（`agent/` 底下一個檔案都不要動；`LatentFromBatch` 是核心節點，agent 端 node policy `installed` 已允許）。
- 所有工作在 `main`，每個任務自己 commit。
- 常數兩棧共用、逐字相同：`EWMA_ALPHA=0.3`、`SPEED_MIN=0.1`、`SPEED_MAX=10`、`LOAD_SEC_PER_GB=1.5`、`FETCH_BYTES_PER_SEC=50e6`、`STARVE_SECONDS=300`、`AGE_WEIGHT=1.0`、`BIG=1e9`、`MAX_SPLIT=8`、default predicted `60`s。
- 白名單 `SPLIT_SAFE_CLASSES` 逐字取自 spec §3.2（載入／條件／模型調整／取樣／Latent 影像五組，不多不少）。
- i18n zh-TW 優先、en 同步（`web/src/i18n/zh-TW.json` 與 `web/src/i18n/en.json` 兩份鍵完全對齊）。
- 測試指令：repo root `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`；`cloud/` 內 `npm test` 與 `npx tsc --noEmit`；`web/` 內 `npm test` 與 `npx tsc --noEmit`。絕不同時跑兩個 pytest suite。
- Alembic 單一新版本 `a2b3c4d5e6f7`（down `f1a2b3c4d5e6`，目前 head）；cloud 單一新 migration `0009_scheduler.sql`。
- 統計更新失敗（DB 例外）只記 log，不影響 job_done 主流程與收據（spec §5）。
- Commit 訊息結尾加上：
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## File Structure

新建：

| 檔案 | 責任 |
|---|---|
| `server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py` | jobs/workers 新欄位 + `worker_job_stats` 表 |
| `cloud/migrations/0009_scheduler.sql` | 同上（D1） |
| `server/comfyfed_server/stats.py` | EWMA / speed_index / predict（純函數 + 薄 DB adapter） |
| `cloud/src/core/stats.ts` | 同上 |
| `server/comfyfed_server/scheduler.py` | 成本模型 + Hungarian（全純函數） |
| `cloud/src/core/scheduler.ts` | 同上 |
| `server/comfyfed_server/split.py` | 可拆判定、子 workflow 重寫、父 job 推導 |
| `cloud/src/core/split.ts` | 同上 |
| `cloud/test/fixtures/scheduler_cases.json` | 兩棧共用的排程黃金 fixture |
| `tests/server/test_stats.py` / `test_scheduler.py` / `test_split.py` | Python 單元測試 |
| `cloud/test/stats.spec.ts` / `scheduler.spec.ts` / `split.spec.ts` | cloud 單元測試 |

修改：`server/comfyfed_server/{db,assess,jobs,dispatch,agentws,comfyapi,panelws,auth}.py`、`cloud/src/{core/{assess,dispatch}.ts,db/queries.ts,do/hub.ts,routes/{jobs,comfyapi,settings}.ts}`、`web/src/{api.ts,pages/{Jobs,JobDetail,Settings}.tsx,i18n/{zh-TW,en}.json}`、`docs/SELF-HOSTING.{zh,en}.md`、既有測試 `tests/server/{test_dispatch,test_agent_ws,test_jobs,test_comfyapi}.py`、`cloud/test/{dispatch,migration,e2e,settings}.spec.ts`。

> **共用 fixture 路徑決定**：`cloud/test/fixtures/scheduler_cases.json`。cloud 的 vitest 跑在 workerd 沙箱裡沒有 `fs`，只能 `import` JSON，而 vite 的 `server.fs.allow` 預設不含 `cloud/` 之外的路徑；反過來 pytest 讀檔案完全自由。所以 fixture 放在 cloud 測試樹內，Python 端用 `Path(__file__).resolve().parents[2] / "cloud" / "test" / "fixtures" / "scheduler_cases.json"` 讀進來。

---

### Task 1: Schema 與工作簽章（兩棧）

**Files:**
- Create: `server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py`
- Create: `cloud/migrations/0009_scheduler.sql`
- Modify: `server/comfyfed_server/db.py:156-200`（`class Job`）、`server/comfyfed_server/db.py:64-114`（`class Worker`）
- Modify: `server/comfyfed_server/assess.py`（檔尾新增 `signature`）
- Modify: `server/comfyfed_server/jobs.py:164-182`（`create_job` 的 insert）
- Modify: `cloud/src/core/assess.ts`（檔尾新增 `signature`）
- Modify: `cloud/src/db/queries.ts:529-560`（`interface Job`）、`:560-583`（`interface JobRow`）、`:583-608`（`rowToJob`）、`:203-256`（`Worker`/`WorkerRow`/`rowToWorker`）、`:612-660`（`NewJob` + `insertJob`）
- Modify: `cloud/src/routes/jobs.ts:334-345`（`insertJob` 呼叫）、`cloud/src/routes/comfyapi.ts:552-563`（`insertJob` 呼叫）
- Test: `tests/server/test_assess.py`（新增 signature 段）、`tests/server/test_dispatch.py`（新增 migration 測試）、`cloud/test/assess.spec.ts`、`cloud/test/migration.spec.ts:10-32`（表清單）與檔尾（新增 0009 describe）

**Interfaces:**
- Consumes: 既有 `assess.extract(workflow) -> JobNeeds`、`assess.needs_from_job(job) -> JobNeeds`；cloud 的 `extract(workflow): JobNeeds`。
- Produces:
  - Python `assess.signature(workflow: dict, needs: "JobNeeds") -> str`（16 字 hex）。
  - TS `export function signature(workflow: Record<string, unknown>, needs: JobNeeds): Promise<string>`（cloud 只有 WebCrypto 的非同步 sha256，所以是 `Promise<string>`；Python 同步）。
  - 欄位：`jobs.signature TEXT NULL`、`jobs.dispatch_info TEXT NOT NULL DEFAULT '{}'`、`jobs.parent_id TEXT NULL`、`jobs.split_index INTEGER NULL`、`jobs.split_count INTEGER NOT NULL DEFAULT 0`、`jobs.split_plan TEXT NULL`、`workers.speed_index REAL NOT NULL DEFAULT 1.0`、`workers.warm_models TEXT NOT NULL DEFAULT '[]'`、表 `worker_job_stats(worker_id TEXT, signature TEXT, ewma_seconds REAL NOT NULL, samples INTEGER NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (worker_id, signature))`。
  - TS `Job` 新欄位：`signature: string | null`、`dispatchInfo: Record<string, unknown>`、`parentId: string | null`、`splitIndex: number | null`、`splitCount: number`、`splitPlan: string | null`；`Worker` 新欄位：`speedIndex: number`、`warmModels: string[]`；`NewJob` 新增 `signature?: string | null`。

- [ ] **Step 1: 先寫失敗的 Python signature 測試**

在 `tests/server/test_assess.py` 檔尾加入：

```python
# --- Phase 3.3 Task 1: 工作簽章 -------------------------------------------

from comfyfed_server import assess as _assess  # noqa: E402  (已在檔頭 import 過就沿用)


def _sig(workflow):
    needs = assess.extract(workflow)
    return assess.signature(workflow, needs)


def test_signature_is_16_hex_chars():
    sig = _sig({"1": {"class_type": "KSampler", "inputs": {"steps": 20}}})
    assert len(sig) == 16
    assert all(c in "0123456789abcdef" for c in sig)


def test_signature_ignores_prompt_text_and_seed():
    a = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 1}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}},
    }
    b = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 999999}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a totally different prompt"}},
    }
    assert _sig(a) == _sig(b)


def test_signature_changes_with_steps_resolution_and_model():
    base = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 20}},
        "2": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    }
    more_steps = json.loads(json.dumps(base))
    more_steps["1"]["inputs"]["steps"] = 24
    bigger = json.loads(json.dumps(base))
    bigger["2"]["inputs"]["width"] = 1024
    other_model = json.loads(json.dumps(base))
    other_model["3"]["inputs"]["ckpt_name"] = "b.safetensors"

    assert _sig(base) != _sig(more_steps)
    assert _sig(base) != _sig(bigger)
    assert _sig(base) != _sig(other_model)


def test_signature_node_counts_matter_but_order_does_not():
    one = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 10}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "x"}},
    }
    reordered = {
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": "y"}},
        "0": {"class_type": "KSampler", "inputs": {"steps": 10}},
    }
    two_encoders = dict(one)
    two_encoders["3"] = {"class_type": "CLIPTextEncode", "inputs": {"text": "z"}}

    assert _sig(one) == _sig(reordered)
    assert _sig(one) != _sig(two_encoders)


def test_signature_linked_inputs_count_as_zero_or_one():
    linked = {
        "1": {"class_type": "KSampler", "inputs": {"steps": ["7", 0]}},
        "2": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": ["7", 1]}},
    }
    literal_zero = {
        "1": {"class_type": "KSampler", "inputs": {}},
        "2": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
    }
    assert _sig(linked) == _sig(literal_zero)


def test_signature_sums_steps_and_mpx_across_nodes():
    single = {"1": {"class_type": "KSampler", "inputs": {"steps": 40}}}
    double = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 20}},
        "2": {"class_type": "KSamplerAdvanced", "inputs": {"steps": 20}},
    }
    # 兩個節點的 steps 加總 = 40，但節點組成不同，所以簽章必然不同；
    # 這個測試釘住的是「加總」本身不會爆炸，見下一個斷言。
    assert _sig(single) != _sig(double)
    same_shape = {
        "1": {"class_type": "KSampler", "inputs": {"steps": 20}},
        "2": {"class_type": "KSamplerAdvanced", "inputs": {"steps": 20}},
        "3": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 2}},
    }
    same_shape_again = json.loads(json.dumps(same_shape))
    assert _sig(same_shape) == _sig(same_shape_again)
```

（`test_assess.py` 檔頭若還沒有 `import json`，補上。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_assess.py -q -k signature`
Expected: FAIL，`AttributeError: module 'comfyfed_server.assess' has no attribute 'signature'`

- [ ] **Step 3: 實作 Python `assess.signature`**

在 `server/comfyfed_server/assess.py` 檔頭 import 區補 `import hashlib`，並在檔尾（`fleet_wide_gaps` 之後）加入：

```python
# Phase 3.3 §2.1: 工作簽章。
# `steps`/`mpx`/`batch` 只讀字面 int，連到別的節點的輸入（ComfyUI API 格式裡
# 是 ["<node_id>", <slot>] 這種 list）一律視為 0/1 -- 簽章要能穩定分群「同一
# 種工作」，不能因為某個值是動態接線就整組崩掉。
_STEP_NODE_CLASSES = ("KSampler", "KSamplerAdvanced", "BasicScheduler")
_LATENT_SIZE_NODE_CLASSES = ("EmptyLatentImage", "EmptySD3LatentImage")
_MPX_UNIT = 262144  # 0.25 MPx 級距


def _literal_int(inputs: dict, field: str) -> int | None:
    value = inputs.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def signature(workflow: dict, needs: "JobNeeds") -> str:
    """穩定的「這是哪一種工作」指紋：sha256 的前 16 個 hex 字。

    同一張圖改 prompt 文字或 seed 不會改簽章；改解析度、步數、模型會改。
    `needs` 由呼叫端的 `extract`/`needs_from_job` 提供，`models` 直接用
    `sorted(needs.models)`，和 `jobs.required_models` 存的是同一組名字。
    """
    counts: dict[str, int] = {}
    steps = 0
    pixels = 0
    batch = 0
    has_batch_node = False

    for _node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            continue
        counts[class_type] = counts.get(class_type, 0) + 1

        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        if class_type in _STEP_NODE_CLASSES:
            steps += _literal_int(inputs, "steps") or 0

        if class_type in _LATENT_SIZE_NODE_CLASSES:
            has_batch_node = True
            width = _literal_int(inputs, "width") or 0
            height = _literal_int(inputs, "height") or 0
            pixels += width * height
            batch += _literal_int(inputs, "batch_size") or 0

    payload = {
        "nodes": sorted(counts.items()),
        "models": sorted(needs.models),
        "steps": steps,
        "mpx": pixels // _MPX_UNIT,
        "batch": batch if (has_batch_node and batch > 0) else 1,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
```

- [ ] **Step 4: 跑測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_assess.py -q -k signature`
Expected: PASS

- [ ] **Step 5: 寫 Alembic migration**

Create `server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py`：

```python
"""Phase 3.3 scheduler + batch split: job signature/dispatch_info/split
columns, worker speed_index/warm_models, worker_job_stats table.

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-09-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("signature", sa.String(), nullable=True))
    op.add_column(
        "jobs",
        sa.Column("dispatch_info", sa.String(), nullable=False, server_default="{}"),
    )
    op.add_column("jobs", sa.Column("parent_id", sa.String(), nullable=True))
    op.add_column("jobs", sa.Column("split_index", sa.Integer(), nullable=True))
    op.add_column(
        "jobs",
        sa.Column("split_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("jobs", sa.Column("split_plan", sa.String(), nullable=True))

    op.add_column(
        "workers",
        sa.Column("speed_index", sa.Float(), nullable=False, server_default="1.0"),
    )
    op.add_column(
        "workers",
        sa.Column("warm_models", sa.String(), nullable=False, server_default="[]"),
    )

    op.create_table(
        "worker_job_stats",
        sa.Column("worker_id", sa.String(), primary_key=True),
        sa.Column("signature", sa.String(), primary_key=True),
        sa.Column("ewma_seconds", sa.Float(), nullable=False),
        sa.Column("samples", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_worker_job_stats_signature", "worker_job_stats", ["signature"])
    op.create_index("ix_jobs_parent_id", "jobs", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_parent_id", table_name="jobs")
    op.drop_index("ix_worker_job_stats_signature", table_name="worker_job_stats")
    op.drop_table("worker_job_stats")
    op.drop_column("workers", "warm_models")
    op.drop_column("workers", "speed_index")
    op.drop_column("jobs", "split_plan")
    op.drop_column("jobs", "split_count")
    op.drop_column("jobs", "split_index")
    op.drop_column("jobs", "parent_id")
    op.drop_column("jobs", "dispatch_info")
    op.drop_column("jobs", "signature")
```

- [ ] **Step 6: 改 ORM model**

在 `server/comfyfed_server/db.py` 的 `class Job`（第 156-200 行）底部、`user_id` 之後加入：

```python
    # Phase 3.3 §2.1: `assess.signature` 算出的工作指紋，送件時寫入。
    # NULL = 舊資料列（migration 不回填；回填由 stats.backfill_if_needed 在
    # 重放收據時順手補上，見 §2.6）。
    signature: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Phase 3.3 §2.2: claim 當下的選擇依據，供 console 顯示。
    # {"predicted_seconds": float, "basis": str, "load_seconds": float,
    #  "fetch_seconds": float, "candidates": int}
    dispatch_info: Mapped[str] = mapped_column(String, default="{}", server_default="{}")
    # Phase 3.3 §3.4: 批次拆分。`parent_id` 指向被拆的父 job（子 job 才有）；
    # `split_count` 是父 job 的子數（0 = 不是父 job，一律當普通 job 處理，
    # 包含重試後被重設為 0 的父 job）；`split_plan` 是送件時算出的
    # `{"source_node_id": str, "batch_size": int}`，NULL = 不可拆。
    parent_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    split_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    split_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    split_plan: Mapped[Optional[str]] = mapped_column(String, nullable=True)
```

在 `class Worker`（第 64-114 行）底部、`peer_url` 之後加入：

```python
    # Phase 3.3 §2.2: 相對全隊的速度係數，1.0 = 平均、2.0 = 兩倍快。
    # 由 stats.record_completion 在每次有效 job_done 後更新，夾在
    # [SPEED_MIN, SPEED_MAX]。
    speed_index: Mapped[float] = mapped_column(Float, default=1.0, server_default="1.0")
    # Phase 3.3 §2.2: 這台 worker 最近一次被指派的 job 的 required_models
    # （JSON array）。在 claim 成功時寫入，不等 job 完成 -- 模型載入發生在
    # 開始執行時，熱快取親和要在那個時間點就成立。
    warm_models: Mapped[str] = mapped_column(String, default="[]", server_default="[]")
```

在 `class Receipt` 之後（第 238 行附近）新增：

```python
class WorkerJobStats(Base):
    """Phase 3.3 §2.2: 每個 (worker, signature) 的執行時間指數移動平均。

    只在 `job_done` 且 `exec_seconds` 有效時更新（failed/cancelled 不更新）
    -- 見 `stats.record_completion`。
    """

    __tablename__ = "worker_job_stats"

    worker_id: Mapped[str] = mapped_column(String, primary_key=True)
    signature: Mapped[str] = mapped_column(String, primary_key=True)
    ewma_seconds: Mapped[float] = mapped_column(Float)
    samples: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
```

- [ ] **Step 7: 寫 migration 測試**

在 `tests/server/test_dispatch.py` 的 `test_alembic_migration_e1f2a3b4c5d6_adds_p2p_columns`（第 139 行）之後加入：

```python
def test_alembic_migration_a2b3c4d5e6f7_adds_scheduler_columns(tmp_path):
    """從前一個 head（f1a2b3c4d5e6）升上來，新欄位與新表都要在，
    而且既有資料列的預設值要正確。"""
    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "f1a2b3c4d5e6")

    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO jobs (id, workflow_json, status, progress, created_at, "
            "result_files, requirements, required_nodes, required_models, "
            "input_assets, result_hashes, origin, panel_hidden) "
            "VALUES ('old-job', '{}', 'done', 0, '2026-01-01 00:00:00', "
            "'[]', '{}', '[]', '[]', '[]', '{}', 'console', 0)"
        )
        conn.execute(
            "INSERT INTO workers (id, name, pubkey, status, disabled, deleted, created_at, "
            "hardware, dynamic, backend, torch_version, node_classes, model_inventory, "
            "object_info_hash, protocol, auto_fetch) "
            "VALUES ('old-w', 'old-w', 'pk', 'offline', 0, 0, '2026-01-01 00:00:00', "
            "'{}', '{}', '', '', '[]', '[]', '', 1, 0)"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        job_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        worker_cols = {row[1] for row in conn.execute("PRAGMA table_info(workers)").fetchall()}
        stats_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(worker_job_stats)").fetchall()
        }
        row = conn.execute(
            "SELECT signature, dispatch_info, parent_id, split_index, split_count, split_plan "
            "FROM jobs WHERE id = 'old-job'"
        ).fetchone()
        worker_row = conn.execute(
            "SELECT speed_index, warm_models FROM workers WHERE id = 'old-w'"
        ).fetchone()
    finally:
        conn.close()

    assert {"signature", "dispatch_info", "parent_id", "split_index", "split_count", "split_plan"} <= job_cols
    assert {"speed_index", "warm_models"} <= worker_cols
    assert {"worker_id", "signature", "ewma_seconds", "samples", "updated_at"} == stats_cols
    assert row == (None, "{}", None, None, 0, None)
    assert worker_row == (1.0, "[]")
```

- [ ] **Step 8: `create_job` 寫入 signature**

`server/comfyfed_server/jobs.py:164-182` 目前是：

```python
    with db.get_session() as session:
        # Live rows only -- ghost hardware from a deleted worker would skew
        # the fleet VRAM estimate the scheduler then matches against.
        all_workers = _live_workers(session)
        est_vram_gb = assess.estimate_vram(needs.models, all_workers)

        job = db.Job(
            workflow_json=workflow_json_text,
            requirements=json.dumps(requirements or {}),
            required_nodes=json.dumps(sorted(needs.nodes)),
            required_models=json.dumps(sorted(needs.models)),
            est_vram_gb=est_vram_gb,
            input_assets=json.dumps(sorted(available)),
            origin=origin,
            user_id=user_id,
        )
        session.add(job)
        session.commit()
        return job.id
```

改成（`split_plan` 留待 Task 6 填，本任務只補 `signature`）：

```python
    with db.get_session() as session:
        # Live rows only -- ghost hardware from a deleted worker would skew
        # the fleet VRAM estimate the scheduler then matches against.
        all_workers = _live_workers(session)
        est_vram_gb = assess.estimate_vram(needs.models, all_workers)

        job = db.Job(
            workflow_json=workflow_json_text,
            requirements=json.dumps(requirements or {}),
            required_nodes=json.dumps(sorted(needs.nodes)),
            required_models=json.dumps(sorted(needs.models)),
            est_vram_gb=est_vram_gb,
            input_assets=json.dumps(sorted(available)),
            origin=origin,
            user_id=user_id,
            # Phase 3.3 §2.1: 送件時算一次，之後派工/統計都只讀這個欄位。
            signature=assess.signature(workflow, needs),
        )
        session.add(job)
        session.commit()
        return job.id
```

並在 `tests/server/test_jobs.py` 加一個測試：

```python
def test_create_job_stores_a_signature(_db):
    workflow = {"1": {"class_type": "KSampler", "inputs": {"steps": 20}}}
    job_id = jobs.create_job(json.dumps(workflow), workflow)
    with db.get_session() as session:
        stored = session.get(db.Job, job_id).signature
    assert isinstance(stored, str) and len(stored) == 16
    assert stored == assess.signature(workflow, assess.extract(workflow))
```

（`_db` fixture、`jobs`/`db`/`assess`/`json` 的 import 沿用 `test_jobs.py` 檔頭既有那組；若 `assess` 沒 import 就補上。）

- [ ] **Step 9: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS（全綠）

- [ ] **Step 10: 寫 D1 migration**

Create `cloud/migrations/0009_scheduler.sql`：

```sql
-- Phase 3.3 排程優化與批次拆分，cloud parity of
-- server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py.

ALTER TABLE jobs ADD COLUMN signature TEXT;
ALTER TABLE jobs ADD COLUMN dispatch_info TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN parent_id TEXT;
ALTER TABLE jobs ADD COLUMN split_index INTEGER;
ALTER TABLE jobs ADD COLUMN split_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN split_plan TEXT;

ALTER TABLE workers ADD COLUMN speed_index REAL NOT NULL DEFAULT 1.0;
ALTER TABLE workers ADD COLUMN warm_models TEXT NOT NULL DEFAULT '[]';

CREATE TABLE worker_job_stats (
  worker_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  ewma_seconds REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, signature)
);

CREATE INDEX ix_worker_job_stats_signature ON worker_job_stats (signature);
CREATE INDEX ix_jobs_parent_id ON jobs (parent_id);
```

- [ ] **Step 11: 更新 cloud migration 測試**

`cloud/test/migration.spec.ts:17-31` 目前斷言的表清單是：

```ts
    expect(names.sort()).toEqual(
      [
        "jobs",
        "login_attempts",
        "model_hashes",
        "nonces",
        "p2p_grants",
        "receipts",
        "register_tokens",
        "settings",
        "upload_tokens",
        "users",
        "workers",
      ].sort()
    );
```

把 `"worker_job_stats",` 加進那個陣列（放在 `"users",` 之後、`"workers",` 之前即可，反正有 `.sort()`）。然後在檔尾（第 252 行 `});` 之後）加入：

```ts
// Phase 3.3 Task 1 cloud parity.
describe("D1 migration 0009_scheduler", () => {
  it("adds the scheduler/split columns to jobs with the right defaults", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of ["signature", "dispatch_info", "parent_id", "split_index", "split_count", "split_plan"]) {
      expect(names.has(col), `jobs.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO jobs (id, workflow_json, created_at) VALUES ('job-0009', '{}', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT signature, dispatch_info, parent_id, split_index, split_count, split_plan FROM jobs WHERE id = 'job-0009'")
      .first<any>();
    expect(row.signature).toBeNull();
    expect(row.dispatch_info).toBe("{}");
    expect(row.parent_id).toBeNull();
    expect(row.split_index).toBeNull();
    expect(row.split_count).toBe(0);
    expect(row.split_plan).toBeNull();
    await db.prepare("DELETE FROM jobs WHERE id = 'job-0009'").run();
  });

  it("adds workers.speed_index and workers.warm_models with defaults", async () => {
    const db = (env as any).DB as D1Database;
    await db
      .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES ('w-0009', 'w', 'pk', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT speed_index, warm_models FROM workers WHERE id = 'w-0009'")
      .first<{ speed_index: number; warm_models: string }>();
    expect(row?.speed_index).toBe(1.0);
    expect(row?.warm_models).toBe("[]");
    await db.prepare("DELETE FROM workers WHERE id = 'w-0009'").run();
  });

  it("creates worker_job_stats keyed by (worker_id, signature)", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(worker_job_stats)").all<{ name: string; pk: number }>();
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.get("worker_id")!.pk).toBeGreaterThan(0);
    expect(byName.get("signature")!.pk).toBeGreaterThan(0);
    for (const col of ["ewma_seconds", "samples", "updated_at"]) {
      expect(byName.has(col), `worker_job_stats.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES ('w1', 's1', 10.0, 1, '2026-01-01 00:00:00.000000')")
      .run();
    await expect(
      db
        .prepare("INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES ('w1', 's1', 20.0, 2, '2026-01-01 00:00:00.000000')")
        .run()
    ).rejects.toThrow();
    await db.prepare("DELETE FROM worker_job_stats").run();
  });
});
```

- [ ] **Step 12: 寫 cloud `signature` 測試**

在 `cloud/test/assess.spec.ts` 檔尾加入：

```ts
import { signature, extract } from "../src/core/assess";
import schedulerCases from "./fixtures/scheduler_cases.json";

async function sig(workflow: Record<string, unknown>): Promise<string> {
  return signature(workflow, extract(workflow));
}

describe("signature (Phase 3.3 §2.1)", () => {
  it("is 16 hex chars", async () => {
    const s = await sig({ "1": { class_type: "KSampler", inputs: { steps: 20 } } });
    expect(s).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores prompt text and seed", async () => {
    const a = {
      "1": { class_type: "KSampler", inputs: { steps: 20, seed: 1 } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    };
    const b = {
      "1": { class_type: "KSampler", inputs: { steps: 20, seed: 999999 } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a totally different prompt" } },
    };
    expect(await sig(a)).toBe(await sig(b));
  });

  it("changes with steps, resolution and model", async () => {
    const base = {
      "1": { class_type: "KSampler", inputs: { steps: 20 } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    };
    const clone = () => JSON.parse(JSON.stringify(base));
    const moreSteps = clone();
    moreSteps["1"].inputs.steps = 24;
    const bigger = clone();
    bigger["2"].inputs.width = 1024;
    const otherModel = clone();
    otherModel["3"].inputs.ckpt_name = "b.safetensors";

    const baseSig = await sig(base);
    expect(await sig(moreSteps)).not.toBe(baseSig);
    expect(await sig(bigger)).not.toBe(baseSig);
    expect(await sig(otherModel)).not.toBe(baseSig);
  });

  it("treats linked inputs as 0/1, same as a missing literal", async () => {
    const linked = {
      "1": { class_type: "KSampler", inputs: { steps: ["7", 0] } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: ["7", 1] } },
    };
    const literalZero = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
    };
    expect(await sig(linked)).toBe(await sig(literalZero));
  });

  // 兩棧 parity：同一組 workflow 必須得到同一個簽章字串。
  it("matches the shared fixture's expected signatures byte for byte", async () => {
    for (const c of schedulerCases.signature_cases) {
      expect(await sig(c.workflow as Record<string, unknown>), c.name).toBe(c.expected);
    }
  });
});
```

- [ ] **Step 13: 建立共用 fixture 骨架**

Create `cloud/test/fixtures/scheduler_cases.json`（Task 3 會再往裡面加 `cost_cases` / `hungarian_cases`；本任務只放 `signature_cases`，`expected` 先留空字串，Step 15 用真實輸出填回）：

```json
{
  "signature_cases": [
    {
      "name": "flux 512 4-step batch 2",
      "workflow": {
        "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "flux1-dev.safetensors" } },
        "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "wuxia swordsman" } },
        "3": { "class_type": "EmptyLatentImage", "inputs": { "width": 512, "height": 512, "batch_size": 2 } },
        "4": { "class_type": "KSampler", "inputs": { "steps": 4, "seed": 424242 } },
        "5": { "class_type": "VAEDecode", "inputs": {} },
        "6": { "class_type": "SaveImage", "inputs": {} }
      },
      "expected": ""
    },
    {
      "name": "zero model stitch job",
      "workflow": {
        "1": { "class_type": "LoadImage", "inputs": { "image": "input.png" } },
        "2": { "class_type": "SaveImage", "inputs": { "images": ["1", 0] } }
      },
      "expected": ""
    }
  ]
}
```

- [ ] **Step 14: 實作 cloud `signature`**

在 `cloud/src/core/assess.ts` 檔尾加入（`bytesToHex` 已在 `../lib/hex`）：

```ts
// ---------------------------------------------------------------------------
// Phase 3.3 §2.1: 工作簽章 -- Python parity source: assess.signature.

const STEP_NODE_CLASSES = ["KSampler", "KSamplerAdvanced", "BasicScheduler"];
const LATENT_SIZE_NODE_CLASSES = ["EmptyLatentImage", "EmptySD3LatentImage"];
const MPX_UNIT = 262144; // 0.25 MPx 級距

function literalInt(inputs: Record<string, unknown>, field: string): number | null {
  const value = inputs[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

/** 穩定的「這是哪一種工作」指紋：sha256 的前 16 個 hex 字。Ports
 * `assess.signature` -- canonical JSON 的鍵順序、`nodes` 的 (class, count)
 * 排序、`mpx` 的整數除法都必須和 Python 逐位元一致，否則兩棧的統計互相
 * 讀不到對方的資料。 */
export async function signature(workflow: Record<string, unknown>, needs: JobNeeds): Promise<string> {
  const counts = new Map<string, number>();
  let steps = 0;
  let pixels = 0;
  let batch = 0;
  let hasBatchNode = false;

  for (const node of Object.values(workflow ?? {})) {
    if (typeof node !== "object" || node === null) continue;
    const classType = (node as Record<string, unknown>).class_type;
    if (typeof classType !== "string") continue;
    counts.set(classType, (counts.get(classType) ?? 0) + 1);

    const inputs = (node as Record<string, unknown>).inputs;
    if (typeof inputs !== "object" || inputs === null) continue;
    const inputRecord = inputs as Record<string, unknown>;

    if (STEP_NODE_CLASSES.includes(classType)) {
      steps += literalInt(inputRecord, "steps") ?? 0;
    }
    if (LATENT_SIZE_NODE_CLASSES.includes(classType)) {
      hasBatchNode = true;
      pixels += (literalInt(inputRecord, "width") ?? 0) * (literalInt(inputRecord, "height") ?? 0);
      batch += literalInt(inputRecord, "batch_size") ?? 0;
    }
  }

  // Python 的 `sorted(counts.items())` 是 (class_type, count) 的字典序；
  // class_type 唯一，所以只比第一項就等價。
  const nodes = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const models = [...needs.models].sort();

  // json.dumps(..., sort_keys=True, separators=(",", ":")) 的等價輸出：鍵序
  // batch < models < mpx < nodes < steps（字典序），沒有多餘空白。
  const canonical = JSON.stringify({
    batch: hasBatchNode && batch > 0 ? batch : 1,
    models,
    mpx: Math.floor(pixels / MPX_UNIT),
    nodes,
    steps,
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}
```

> ⚠ Python 端的 `json.dumps(payload, sort_keys=True, ...)` 也會把鍵排成
> `batch, models, mpx, nodes, steps`，所以上面的字面順序就是兩棧一致的關鍵。
> 檔頭若還沒有 `import { bytesToHex } from "../lib/hex";` 就補上。

- [ ] **Step 15: 用真實輸出填回 fixture 的 `expected`**

Run（repo root）：

```bash
.venv/Scripts/python.exe - <<'PY'
import json, pathlib, sys
sys.path.insert(0, "server")
from comfyfed_server import assess
p = pathlib.Path("cloud/test/fixtures/scheduler_cases.json")
data = json.loads(p.read_text(encoding="utf-8"))
for case in data["signature_cases"]:
    wf = case["workflow"]
    case["expected"] = assess.signature(wf, assess.extract(wf))
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps(data["signature_cases"], indent=2, ensure_ascii=False))
PY
```

把印出來的 `expected` 值確認非空，然後跑 cloud 測試驗證 TS 端算出同一個值。

- [ ] **Step 16: `queries.ts` 讀寫新欄位**

`cloud/src/db/queries.ts` 的 `interface Job`（第 529 行起）在 `userId: string | null;` 之後加入：

```ts
  /** Phase 3.3 §2.1: `assess.signature` 的工作指紋，送件時寫入；`null` 是
   * 舊資料列（`stats.backfillIfNeeded` 重放收據時會補寫回去）。 */
  signature: string | null;
  /** Phase 3.3 §2.2: claim 當下的選擇依據（predicted_seconds / basis /
   * load_seconds / fetch_seconds / candidates），供 console 顯示。 */
  dispatchInfo: Record<string, unknown>;
  /** Phase 3.3 §3.4: 被拆的父 job id（子 job 才有）。 */
  parentId: string | null;
  splitIndex: number | null;
  /** 父 job 的子數；0 = 不是父 job，一律當普通 job 處理。 */
  splitCount: number;
  /** `{"source_node_id": string, "batch_size": number}` 的 JSON 原文，
   * `null` = 不可拆。刻意保留字串而不是解析後的物件：只有 split.ts 需要
   * 它，rowToJob 不該替每一列付這個解析成本。 */
  splitPlan: string | null;
```

`interface JobRow`（第 560 行起）在 `user_id: string | null;` 之後加入：

```ts
  signature: string | null;
  dispatch_info: string;
  parent_id: string | null;
  split_index: number | null;
  split_count: number;
  split_plan: string | null;
```

`rowToJob`（第 583 行起）在 `userId: row.user_id,` 之後加入：

```ts
    signature: row.signature,
    dispatchInfo: safeParse(row.dispatch_info, {}),
    parentId: row.parent_id,
    splitIndex: row.split_index,
    splitCount: row.split_count ?? 0,
    splitPlan: row.split_plan,
```

`interface Worker`（第 203 行起）在 `peerUrl: string | null;` 之後加入：

```ts
  /** Phase 3.3 §2.2: 相對全隊的速度係數，1.0 = 平均、2.0 = 兩倍快。 */
  speedIndex: number;
  /** Phase 3.3 §2.2: 最近一次被指派的 job 的 required_models；claim 時寫入。 */
  warmModels: string[];
```

`interface WorkerRow` 在 `peer_url: string | null;` 之後加入：

```ts
  speed_index: number;
  warm_models: string;
```

`rowToWorker` 的回傳物件加上：

```ts
    speedIndex: typeof row.speed_index === "number" ? row.speed_index : 1.0,
    warmModels: safeParse(row.warm_models, []),
```

`interface NewJob`（第 612 行起）在 `userId?: string | null;` 之後加入：

```ts
  /** Phase 3.3 §2.1: 送件時算好的工作指紋。 */
  signature?: string | null;
```

`insertJob`（第 632-660 行）目前是：

```ts
export async function insertJob(db: D1Database, job: NewJob): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (id, workflow_json, requirements, required_nodes, required_models, est_vram_gb,
                          input_assets, origin, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      job.id,
      job.workflowJson,
      JSON.stringify(job.requirements),
      JSON.stringify(job.requiredNodes),
      JSON.stringify(job.requiredModels),
      job.estVramGb,
      JSON.stringify(job.inputAssets),
      job.origin,
      job.createdAt,
      job.userId ?? null
    )
    .run();
}
```

改成：

```ts
export async function insertJob(db: D1Database, job: NewJob): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (id, workflow_json, requirements, required_nodes, required_models, est_vram_gb,
                          input_assets, origin, created_at, user_id, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      job.id,
      job.workflowJson,
      JSON.stringify(job.requirements),
      JSON.stringify(job.requiredNodes),
      JSON.stringify(job.requiredModels),
      job.estVramGb,
      JSON.stringify(job.inputAssets),
      job.origin,
      job.createdAt,
      job.userId ?? null,
      job.signature ?? null
    )
    .run();
}
```

- [ ] **Step 17: 兩個 insertJob 呼叫端帶上 signature**

`cloud/src/routes/jobs.ts:334-345` 的 `await queries.insertJob(c.env.DB, {...})`：在 `userId: user.uid,` 之後加入 `signature: await signature(workflow, needs),`，並把檔頭第 40 行的 import 改成包含 `signature`：

```ts
import { extract, estimateVram, needsFromJob, signature, verdict, fleetWideGaps, partitionFleetFetchable, type JobNeeds, type FetchableModels } from "../core/assess";
```

`cloud/src/routes/comfyapi.ts:552-563` 同樣在 `userId: user.uid,` 之後加入 `signature: await signature(promptObj, needs),`，並把第 53 行的 import 補上 `signature`：

```ts
import { extract, estimateVram, modelNodes, signature, fleetWideGaps, partitionFleetFetchable, type FetchableModels } from "../core/assess";
```

在 `cloud/test/jobs.spec.ts` 加一個測試：

```ts
it("stores a signature on the inserted job row", async () => {
  const { cookie, csrf } = await adminSession();
  const workflow = { "1": { class_type: "KSampler", inputs: { steps: 20 } } };
  const form = new FormData();
  form.set("workflow_json", JSON.stringify(workflow));
  const res = await raw("/api/jobs", { method: "POST", body: form, cookie, headers: { "X-CSRF": csrf } });
  expect(res.status).toBe(200);
  const row = await db().prepare("SELECT signature FROM jobs WHERE id = ?").bind(res.body.job_id).first<{ signature: string | null }>();
  expect(row?.signature).toMatch(/^[0-9a-f]{16}$/);
});
```

> 這個 `it` 要放進 `jobs.spec.ts` 既有的 `describe("POST /api/jobs", ...)` 區塊裡，沿用該檔既有的 `adminSession()` / `raw()` / `db()` helper；若該檔的 helper 名稱不同，照它自己的來，不要新建一份。

- [ ] **Step 18: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠、無型別錯誤

- [ ] **Step 19: Commit**

```bash
git add server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py server/comfyfed_server/db.py server/comfyfed_server/assess.py server/comfyfed_server/jobs.py tests/server/test_assess.py tests/server/test_dispatch.py tests/server/test_jobs.py cloud/migrations/0009_scheduler.sql cloud/src/core/assess.ts cloud/src/db/queries.ts cloud/src/routes/jobs.ts cloud/src/routes/comfyapi.ts cloud/test/assess.spec.ts cloud/test/migration.spec.ts cloud/test/jobs.spec.ts cloud/test/fixtures/scheduler_cases.json
git commit -m "$(cat <<'EOF'
feat(scheduler): add job signature, scheduler/split schema on both stacks

Phase 3.3 Task 1. Alembic a2b3c4d5e6f7 + D1 0009 add jobs.signature/
dispatch_info/parent_id/split_index/split_count/split_plan, workers.
speed_index/warm_models and the worker_job_stats table. assess.signature()
lands on both stacks with a shared golden fixture, and create_job/insertJob
now persist it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 統計模組 stats（兩棧）

**Files:**
- Create: `server/comfyfed_server/stats.py`
- Create: `cloud/src/core/stats.ts`
- Modify: `server/comfyfed_server/app.py`（啟動時呼叫回填）
- Test: `tests/server/test_stats.py`（新檔）、`cloud/test/stats.spec.ts`（新檔）

**Interfaces:**
- Consumes: Task 1 的 `db.WorkerJobStats`、`db.Worker.speed_index`、`db.Job.signature`、`assess.signature(workflow, needs)`；cloud 的 `queries.Worker.speedIndex`、`worker_job_stats` 表、`signature(workflow, needs): Promise<string>`。
- Produces（Task 3/4 全部依賴這些名字）：
  - Python：`stats.StatRow(worker_id: str, signature: str, ewma_seconds: float, samples: int)`（frozen dataclass）；`stats.median(values: list[float]) -> float | None`；`stats.fleet_reference(rows: list[StatRow], speed_index: dict[str, float], signature: str, exclude_worker_id: str | None) -> float | None`；`stats.next_ewma(previous: float | None, exec_seconds: float) -> float`；`stats.next_speed_index(current: float, reference: float | None, exec_seconds: float) -> float`；`stats.predict(rows: list[StatRow], speed_index: dict[str, float], signature: str | None, worker_id: str) -> tuple[float, str]`；`stats.load_rows() -> list[StatRow]`；`stats.load_speed_index() -> dict[str, float]`；`stats.record_completion(worker_id: str, signature: str | None, exec_seconds: float | None) -> None`；`stats.backfill_if_needed() -> bool`；`stats.is_valid_exec_seconds(value) -> bool`。常數 `EWMA_ALPHA`、`SPEED_MIN`、`SPEED_MAX`、`DEFAULT_PREDICTED_SECONDS`、`BACKFILL_LIMIT`、`BACKFILL_SETTING_KEY`。
  - TS：`export type Basis = "signature" | "speed_index" | "fleet_default" | "none"`；`export interface StatRow { workerId: string; signature: string; ewmaSeconds: number; samples: number }`；`median(values: number[]): number | null`；`fleetReference(rows, speedIndex: Map<string, number>, signature: string, excludeWorkerId: string | null): number | null`；`nextEwma(previous: number | null, execSeconds: number): number`；`nextSpeedIndex(current: number, reference: number | null, execSeconds: number): number`；`predict(rows, speedIndex, signature: string | null, workerId: string): { seconds: number; basis: Basis }`；`loadRows(db)`；`loadSpeedIndex(db)`；`recordCompletion(db, workerId, signature, execSeconds, now: Date): Promise<void>`；`backfillIfNeeded(db): Promise<boolean>`；`isValidExecSeconds(v): v is number`。

- [ ] **Step 1: 寫失敗的 Python 測試**

Create `tests/server/test_stats.py`：

```python
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_stats.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'comfyfed_server.stats'`

- [ ] **Step 3: 實作 `server/comfyfed_server/stats.py`**

```python
"""Phase 3.3 §2.2-§2.4 / §2.6: 每台 worker 跑每種工作有多快。

模組分兩層：上半是完全不碰 DB 的純函數（EWMA、隊伍參考值、speed_index
更新、predict 的 basis ladder），兩棧逐行對照 `cloud/src/core/stats.ts`；
下半是薄薄的 DB adapter。所有 adapter 都吞掉例外只記 log -- 統計壞掉絕不能
影響 job_done 主流程與收據（spec §5）。
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from . import assess, db

logger = logging.getLogger(__name__)

EWMA_ALPHA = 0.3
SPEED_MIN = 0.1
SPEED_MAX = 10.0
DEFAULT_PREDICTED_SECONDS = 60.0

# §2.6: 回填只重放最近這麼多筆收據，且只做一次。
BACKFILL_LIMIT = 500
BACKFILL_SETTING_KEY = "stats_backfilled"


@dataclass(frozen=True)
class StatRow:
    worker_id: str
    signature: str
    ewma_seconds: float
    samples: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_valid_exec_seconds(exec_seconds) -> bool:
    """有效樣本：真實、有限、非負的數字。和 `agentws._is_valid_exec_seconds`
    同一組條件，複寫在這裡而不是 import，是為了讓本模組維持可獨立測試的純
    函數層（agentws 會拉進整個 WebSocket 世界）。"""
    return (
        exec_seconds is not None
        and isinstance(exec_seconds, (int, float))
        and not isinstance(exec_seconds, bool)
        and math.isfinite(exec_seconds)
        and exec_seconds >= 0
    )


# --- 純函數層 --------------------------------------------------------------


def median(values: list[float]) -> Optional[float]:
    """偶數個取中間兩個的平均，空的回 None。自己寫而不是用 statistics.median
    是為了和 TS 端逐行對照（TS 沒有標準庫中位數）。"""
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def fleet_reference(
    rows: list[StatRow],
    speed_index: dict[str, float],
    signature: str,
    exclude_worker_id: Optional[str],
) -> Optional[float]:
    """§2.3 的 R(sig)：其他 worker 該簽章 `ewma × speed_index` 的中位數。

    乘上 speed_index 是把每台機的觀測值折算回「平均機」的尺度，這樣不同速度
    的機器才能放進同一個中位數比較。沒有其他 worker 的資料時回 None，呼叫端
    據此決定「不更新」或「往下一階 fallback」。
    """
    values = [
        row.ewma_seconds * speed_index.get(row.worker_id, 1.0)
        for row in rows
        if row.signature == signature and row.worker_id != exclude_worker_id
    ]
    return median(values)


def next_ewma(previous: Optional[float], exec_seconds: float) -> float:
    """第一筆樣本直接就是 EWMA 本身；之後 `0.3*exec + 0.7*previous`。"""
    if previous is None:
        return float(exec_seconds)
    return EWMA_ALPHA * float(exec_seconds) + (1.0 - EWMA_ALPHA) * float(previous)


def next_speed_index(current: float, reference: Optional[float], exec_seconds: float) -> float:
    """§2.3 第 2 條：`ratio = R(sig)/exec`，再和現值做同一個 α 的混合後夾住。

    `reference is None`（沒有別人的資料）或 `exec_seconds <= 0`（除不下去）
    一律維持原值 -- 寧可不更新，也不要寫進一個 inf。
    """
    if reference is None or exec_seconds <= 0:
        return current
    ratio = reference / exec_seconds
    blended = EWMA_ALPHA * ratio + (1.0 - EWMA_ALPHA) * current
    return max(SPEED_MIN, min(SPEED_MAX, blended))


def predict(
    rows: list[StatRow],
    speed_index: dict[str, float],
    signature: Optional[str],
    worker_id: str,
) -> tuple[float, str]:
    """§2.4 的四階梯：signature -> speed_index -> fleet_default -> none。

    回傳 `(seconds, basis)`；`basis` 原樣寫進 `jobs.dispatch_info`，console
    就能說明「這個預估是怎麼來的」。
    """
    own_speed = speed_index.get(worker_id, 1.0)
    if not isinstance(own_speed, (int, float)) or own_speed <= 0:
        own_speed = 1.0

    if signature:
        for row in rows:
            if row.worker_id == worker_id and row.signature == signature:
                return row.ewma_seconds, "signature"

        reference = fleet_reference(rows, speed_index, signature, exclude_worker_id=worker_id)
        if reference is not None:
            return reference / own_speed, "speed_index"

    fleet_median = median([row.ewma_seconds for row in rows])
    if fleet_median is not None:
        return fleet_median / own_speed, "fleet_default"

    return DEFAULT_PREDICTED_SECONDS, "none"


# --- DB adapter 層 ---------------------------------------------------------


def load_rows() -> list[StatRow]:
    """整張 `worker_job_stats`。故意一次全讀：一個家用聯邦的 (worker,
    signature) 組合是幾十到幾百列，每個 tick 一次全表讀遠比每對候選跑一次
    查詢便宜，而且讓 `predict` 維持純函數。"""
    try:
        with db.get_session() as session:
            return [
                StatRow(
                    worker_id=row.worker_id,
                    signature=row.signature,
                    ewma_seconds=row.ewma_seconds,
                    samples=row.samples,
                )
                for row in session.query(db.WorkerJobStats).all()
            ]
    except Exception:
        logger.exception("stats: load_rows failed")
        return []


def load_speed_index() -> dict[str, float]:
    try:
        with db.get_session() as session:
            return {
                w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
                for w in session.query(db.Worker).all()
            }
    except Exception:
        logger.exception("stats: load_speed_index failed")
        return {}


def record_completion(
    worker_id: str, signature: Optional[str], exec_seconds: Optional[float]
) -> None:
    """§2.3：只在 job_done 且 `exec_seconds` 有效時更新。

    失敗只記 log -- 呼叫端（`agentws._handle_job_done`）絕不能因此少發一張
    收據。
    """
    if not signature or not is_valid_exec_seconds(exec_seconds):
        return
    exec_value = float(exec_seconds)

    try:
        with db.get_session() as session:
            rows = [
                StatRow(
                    worker_id=r.worker_id,
                    signature=r.signature,
                    ewma_seconds=r.ewma_seconds,
                    samples=r.samples,
                )
                for r in session.query(db.WorkerJobStats).all()
            ]
            speed_index = {
                w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
                for w in session.query(db.Worker).all()
            }

            # 1) EWMA。
            existing = session.get(db.WorkerJobStats, (worker_id, signature))
            if existing is None:
                session.add(
                    db.WorkerJobStats(
                        worker_id=worker_id,
                        signature=signature,
                        ewma_seconds=next_ewma(None, exec_value),
                        samples=1,
                        updated_at=_utcnow(),
                    )
                )
            else:
                existing.ewma_seconds = next_ewma(existing.ewma_seconds, exec_value)
                existing.samples = existing.samples + 1
                existing.updated_at = _utcnow()

            # 2) speed_index。參考值算在 EWMA 更新「之前」的快照上，且排除
            #    自己 -- 否則這一筆會同時當觀測值和參考值，自我校正成 1.0。
            worker = session.get(db.Worker, worker_id)
            if worker is not None:
                reference = fleet_reference(
                    rows, speed_index, signature, exclude_worker_id=worker_id
                )
                current = worker.speed_index if isinstance(worker.speed_index, (int, float)) else 1.0
                worker.speed_index = next_speed_index(current, reference, exec_value)

            session.commit()
    except Exception:
        logger.exception(
            "stats: record_completion failed for worker %s signature %s", worker_id, signature
        )


def backfill_if_needed() -> bool:
    """§2.6：第一次啟動時用最近 500 筆完成收據重放一次 `record_completion`。

    回傳「這次有沒有真的跑回填」（旗標已設 -> False）。簽章缺的 job 先由
    `workflow_json` 補算並寫回 `jobs.signature`，所以回填同時也是舊資料的
    簽章補齊通道。
    """
    try:
        with db.get_session() as session:
            flag = session.get(db.Setting, BACKFILL_SETTING_KEY)
            if flag is not None and flag.value == "1":
                return False
            if session.query(db.WorkerJobStats).first() is not None:
                session.add(db.Setting(key=BACKFILL_SETTING_KEY, value="1"))
                session.commit()
                return False

            receipts = (
                session.query(db.Receipt)
                .filter(db.Receipt.kind == "completed", db.Receipt.billable == True)  # noqa: E712
                .order_by(db.Receipt.created_at.desc())
                .limit(BACKFILL_LIMIT)
                .all()
            )
            replay = list(reversed(receipts))  # 依 created_at 由舊到新重放

            pending: list[tuple[str, str, float]] = []
            for receipt in replay:
                if receipt.job_id is None:
                    continue
                job = session.get(db.Job, receipt.job_id)
                if job is None:
                    continue
                signature = job.signature
                if not signature:
                    try:
                        workflow = json.loads(job.workflow_json or "{}")
                    except (TypeError, ValueError):
                        continue
                    if not isinstance(workflow, dict):
                        continue
                    signature = assess.signature(workflow, assess.needs_from_job(job))
                    job.signature = signature
                pending.append((receipt.worker_id, signature, receipt.gpu_seconds))

            session.commit()
    except Exception:
        logger.exception("stats: backfill scan failed")
        return False

    for worker_id, signature, exec_seconds in pending:
        record_completion(worker_id, signature, exec_seconds)

    try:
        with db.get_session() as session:
            flag = session.get(db.Setting, BACKFILL_SETTING_KEY)
            if flag is None:
                session.add(db.Setting(key=BACKFILL_SETTING_KEY, value="1"))
            else:
                flag.value = "1"
            session.commit()
    except Exception:
        logger.exception("stats: failed to set the backfill flag")

    return True
```

- [ ] **Step 4: 跑測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_stats.py -q`
Expected: PASS

- [ ] **Step 5: 在 app 啟動時掛上回填**

用 `grep -n "startup\|lifespan\|init_db" server/comfyfed_server/app.py` 定位啟動流程。在 `db.init_db(...)` 之後、`agentws.start_background_task()` 之前插入：

```python
    # Phase 3.3 §2.6: 舊安裝第一次跑到這裡時，用最近 500 筆完成收據把
    # worker_job_stats 補起來，免得排程器上線後要從零重新學。只做一次
    # （stats.BACKFILL_SETTING_KEY 旗標），失敗只記 log。
    stats.backfill_if_needed()
```

並把 `stats` 加進 `app.py` 的 `from . import ...` 清單。

- [ ] **Step 6: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 7: 寫 cloud stats 測試**

Create `cloud/test/stats.spec.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as stats from "../src/core/stats";
import { toSqliteTimestamp } from "../src/db/queries";

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await db().prepare("DELETE FROM worker_job_stats").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM settings").run();
});

function rows(...triples: [string, string, number][]): stats.StatRow[] {
  return triples.map(([workerId, signature, ewmaSeconds]) => ({ workerId, signature, ewmaSeconds, samples: 1 }));
}

describe("median", () => {
  it("is null for an empty list", () => expect(stats.median([])).toBeNull());
  it("takes the middle value for an odd count", () => expect(stats.median([5, 1, 3])).toBe(3));
  it("averages the two middle values for an even count", () => expect(stats.median([1, 2, 3, 4])).toBe(2.5));
});

describe("nextEwma", () => {
  it("is the sample itself on the first observation", () => expect(stats.nextEwma(null, 42)).toBe(42));
  it("blends with alpha 0.3", () => expect(stats.nextEwma(10, 20)).toBeCloseTo(13, 10));
});

describe("fleetReference", () => {
  it("excludes the reporting worker", () => {
    const speed = new Map([["w1", 1], ["w2", 1], ["w3", 1]]);
    expect(stats.fleetReference(rows(["w1", "sig", 10], ["w2", "sig", 20], ["w3", "sig", 30]), speed, "sig", "w1")).toBe(25);
  });

  it("weights each observation by that worker's speed index", () => {
    expect(stats.fleetReference(rows(["w2", "sig", 10]), new Map([["w2", 2]]), "sig", "w1")).toBe(20);
  });

  it("is null when nobody else has data for the signature", () => {
    expect(stats.fleetReference(rows(["w1", "sig", 10]), new Map([["w1", 1]]), "sig", "w1")).toBeNull();
    expect(stats.fleetReference(rows(["w2", "other", 10]), new Map([["w2", 1]]), "sig", "w1")).toBeNull();
  });
});

describe("nextSpeedIndex", () => {
  it("is unchanged without a reference", () => expect(stats.nextSpeedIndex(1, null, 10)).toBe(1));
  it("rises when faster than the fleet", () => expect(stats.nextSpeedIndex(1, 20, 10)).toBeCloseTo(1.3, 10));
  it("falls when slower than the fleet", () => expect(stats.nextSpeedIndex(1, 10, 20)).toBeCloseTo(0.85, 10));
  it("clamps to the bounds", () => {
    expect(stats.nextSpeedIndex(10, 1e9, 1)).toBe(stats.SPEED_MAX);
    expect(stats.nextSpeedIndex(0.1, 1, 1e9)).toBe(stats.SPEED_MIN);
  });
  it("is unchanged when exec is zero", () => expect(stats.nextSpeedIndex(1, 20, 0)).toBe(1));
});

describe("predict (§2.4 basis ladder)", () => {
  it("uses this worker's own row first", () => {
    const r = stats.predict(rows(["w1", "sig", 41.2], ["w2", "sig", 80]), new Map([["w1", 1], ["w2", 1]]), "sig", "w1");
    expect(r).toEqual({ seconds: 41.2, basis: "signature" });
  });

  it("falls back to the fleet reference scaled by speed index", () => {
    const r = stats.predict(rows(["w2", "sig", 40]), new Map([["w1", 2], ["w2", 1]]), "sig", "w1");
    expect(r.basis).toBe("speed_index");
    expect(r.seconds).toBeCloseTo(20, 10);
  });

  it("falls back to the fleet median over every signature", () => {
    const r = stats.predict(rows(["w2", "other-a", 10], ["w2", "other-b", 30]), new Map([["w1", 1], ["w2", 1]]), "sig", "w1");
    expect(r.basis).toBe("fleet_default");
    expect(r.seconds).toBeCloseTo(20, 10);
  });

  it("falls back to 60s with no data at all", () => {
    expect(stats.predict([], new Map(), "sig", "w1")).toEqual({ seconds: stats.DEFAULT_PREDICTED_SECONDS, basis: "none" });
  });

  it("skips the signature rungs when the job has no signature", () => {
    const r = stats.predict(rows(["w2", "other", 30]), new Map([["w1", 1], ["w2", 1]]), null, "w1");
    expect(r.basis).toBe("fleet_default");
    expect(r.seconds).toBeCloseTo(30, 10);
  });
});

async function makeWorker(id: string, speedIndex = 1.0): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at, speed_index) VALUES (?, ?, 'pk', ?, ?)")
    .bind(id, id, toSqliteTimestamp(new Date()), speedIndex)
    .run();
}

describe("recordCompletion", () => {
  it("inserts the first row and leaves speed_index alone", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", "sig", 30, new Date());
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBe(30);
    expect(row.samples).toBe(1);
    const worker = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w1'").first<any>();
    expect(worker.speed_index).toBe(1.0);
  });

  it("blends an existing row", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", "sig", 10, new Date());
    await stats.recordCompletion(db(), "w1", "sig", 20, new Date());
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBeCloseTo(13, 10);
    expect(row.samples).toBe(2);
  });

  it("updates speed_index against the other workers", async () => {
    await makeWorker("w1");
    await makeWorker("w2");
    await stats.recordCompletion(db(), "w2", "sig", 20, new Date());
    await stats.recordCompletion(db(), "w1", "sig", 10, new Date());
    const w1 = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w1'").first<any>();
    const w2 = await db().prepare("SELECT speed_index FROM workers WHERE id = 'w2'").first<any>();
    expect(w1.speed_index).toBeCloseTo(1.3, 10);
    expect(w2.speed_index).toBe(1.0);
  });

  it("ignores a missing signature or invalid exec seconds", async () => {
    await makeWorker("w1");
    await stats.recordCompletion(db(), "w1", null, 30, new Date());
    await stats.recordCompletion(db(), "w1", "sig", null, new Date());
    await stats.recordCompletion(db(), "w1", "sig", NaN, new Date());
    await stats.recordCompletion(db(), "w1", "sig", -1, new Date());
    const row = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(row.n).toBe(0);
  });
});

describe("backfillIfNeeded (§2.6)", () => {
  it("replays completed billable receipts oldest-first and sets the flag", async () => {
    await makeWorker("w1");
    const workflow = JSON.stringify({ "1": { class_type: "KSampler", inputs: { steps: 20 } } });
    for (let i = 0; i < 2; i++) {
      await db()
        .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES (?, ?, 'done', ?)")
        .bind(`j${i}`, workflow, `2026-01-01 00:00:0${i}.000000`)
        .run();
      await db()
        .prepare(
          "INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis) VALUES (?, ?, 'w1', ?, 'sig', ?, 'completed', 1, 'exec')"
        )
        .bind(`r${i}`, `j${i}`, 10 * (i + 1), `2026-01-01 00:00:0${i}.000000`)
        .run();
    }

    expect(await stats.backfillIfNeeded(db())).toBe(true);

    const job = await db().prepare("SELECT signature FROM jobs WHERE id = 'j0'").first<any>();
    expect(job.signature).toMatch(/^[0-9a-f]{16}$/);
    const row = await db().prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = 'w1'").first<any>();
    expect(row.ewma_seconds).toBeCloseTo(13, 10);
    expect(row.samples).toBe(2);

    expect(await stats.backfillIfNeeded(db())).toBe(false);
  });

  it("skips failed / non-billable receipts", async () => {
    await makeWorker("w1");
    await db().prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('j0', '{}', 'failed', '2026-01-01 00:00:00.000000')").run();
    await db()
      .prepare("INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis) VALUES ('r0', 'j0', 'w1', 10, 'sig', '2026-01-01 00:00:00.000000', 'failed', 0, 'wall')")
      .run();
    expect(await stats.backfillIfNeeded(db())).toBe(true);
    const row = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(row.n).toBe(0);
  });
});
```

- [ ] **Step 8: 實作 `cloud/src/core/stats.ts`**

```ts
/**
 * Phase 3.3 §2.2-§2.4 / §2.6: 每台 worker 跑每種工作有多快。
 * Parity source: `server/comfyfed_server/stats.py` -- 上半是純函數（逐行對
 * 照），下半是薄薄的 D1 adapter。統計壞掉絕不能影響 job_done 主流程與收據
 * （spec §5），所以每個 adapter 都自己吞例外。
 */

import * as queries from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { extract, signature as computeSignature } from "./assess";

export const EWMA_ALPHA = 0.3;
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10.0;
export const DEFAULT_PREDICTED_SECONDS = 60.0;

export const BACKFILL_LIMIT = 500;
export const BACKFILL_SETTING_KEY = "stats_backfilled";

export type Basis = "signature" | "speed_index" | "fleet_default" | "none";

export interface StatRow {
  workerId: string;
  signature: string;
  ewmaSeconds: number;
  samples: number;
}

export function isValidExecSeconds(execSeconds: unknown): execSeconds is number {
  return typeof execSeconds === "number" && Number.isFinite(execSeconds) && execSeconds >= 0;
}

// --- 純函數層 --------------------------------------------------------------

/** 偶數個取中間兩個的平均，空的回 null -- ports `stats.median`. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** §2.3 的 R(sig) -- ports `stats.fleet_reference`. */
export function fleetReference(
  rows: StatRow[],
  speedIndex: Map<string, number>,
  signature: string,
  excludeWorkerId: string | null
): number | null {
  const values = rows
    .filter((r) => r.signature === signature && r.workerId !== excludeWorkerId)
    .map((r) => r.ewmaSeconds * (speedIndex.get(r.workerId) ?? 1.0));
  return median(values);
}

/** Ports `stats.next_ewma`. */
export function nextEwma(previous: number | null, execSeconds: number): number {
  if (previous === null) return execSeconds;
  return EWMA_ALPHA * execSeconds + (1 - EWMA_ALPHA) * previous;
}

/** Ports `stats.next_speed_index` -- 沒有參考值或 exec<=0 一律維持原值。 */
export function nextSpeedIndex(current: number, reference: number | null, execSeconds: number): number {
  if (reference === null || execSeconds <= 0) return current;
  const ratio = reference / execSeconds;
  const blended = EWMA_ALPHA * ratio + (1 - EWMA_ALPHA) * current;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, blended));
}

/** §2.4 的四階梯 -- ports `stats.predict`. */
export function predict(
  rows: StatRow[],
  speedIndex: Map<string, number>,
  signature: string | null,
  workerId: string
): { seconds: number; basis: Basis } {
  let ownSpeed = speedIndex.get(workerId) ?? 1.0;
  if (!(ownSpeed > 0)) ownSpeed = 1.0;

  if (signature) {
    for (const row of rows) {
      if (row.workerId === workerId && row.signature === signature) {
        return { seconds: row.ewmaSeconds, basis: "signature" };
      }
    }
    const reference = fleetReference(rows, speedIndex, signature, workerId);
    if (reference !== null) return { seconds: reference / ownSpeed, basis: "speed_index" };
  }

  const fleetMedian = median(rows.map((r) => r.ewmaSeconds));
  if (fleetMedian !== null) return { seconds: fleetMedian / ownSpeed, basis: "fleet_default" };

  return { seconds: DEFAULT_PREDICTED_SECONDS, basis: "none" };
}

// --- D1 adapter 層 ---------------------------------------------------------

export async function loadRows(db: D1Database): Promise<StatRow[]> {
  try {
    const { results } = await db
      .prepare("SELECT worker_id, signature, ewma_seconds, samples FROM worker_job_stats")
      .all<{ worker_id: string; signature: string; ewma_seconds: number; samples: number }>();
    return results.map((r) => ({
      workerId: r.worker_id,
      signature: r.signature,
      ewmaSeconds: r.ewma_seconds,
      samples: r.samples,
    }));
  } catch (err) {
    console.error("stats: loadRows failed", err);
    return [];
  }
}

export async function loadSpeedIndex(db: D1Database): Promise<Map<string, number>> {
  try {
    const { results } = await db
      .prepare("SELECT id, speed_index FROM workers")
      .all<{ id: string; speed_index: number }>();
    return new Map(results.map((r) => [r.id, typeof r.speed_index === "number" ? r.speed_index : 1.0]));
  } catch (err) {
    console.error("stats: loadSpeedIndex failed", err);
    return new Map();
  }
}

/** §2.3 -- ports `stats.record_completion`. */
export async function recordCompletion(
  db: D1Database,
  workerId: string,
  signature: string | null,
  execSeconds: number | null,
  now: Date
): Promise<void> {
  if (!signature || !isValidExecSeconds(execSeconds)) return;

  try {
    const rows = await loadRows(db);
    const speedIndex = await loadSpeedIndex(db);

    const existing = rows.find((r) => r.workerId === workerId && r.signature === signature) ?? null;
    const ewma = nextEwma(existing ? existing.ewmaSeconds : null, execSeconds);
    const samples = (existing?.samples ?? 0) + 1;

    await db
      .prepare(
        `INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (worker_id, signature) DO UPDATE SET
           ewma_seconds = excluded.ewma_seconds,
           samples = excluded.samples,
           updated_at = excluded.updated_at`
      )
      .bind(workerId, signature, ewma, samples, toSqliteTimestamp(now))
      .run();

    // 參考值算在 EWMA 更新「之前」的快照（`rows`）上，且排除自己 -- 否則這
    // 一筆會同時當觀測值和參考值，自我校正成 1.0。
    const reference = fleetReference(rows, speedIndex, signature, workerId);
    const current = speedIndex.get(workerId) ?? 1.0;
    const updated = nextSpeedIndex(current, reference, execSeconds);
    if (updated !== current) {
      await db.prepare("UPDATE workers SET speed_index = ? WHERE id = ?").bind(updated, workerId).run();
    }
  } catch (err) {
    console.error(`stats: recordCompletion failed for worker ${workerId} signature ${signature}`, err);
  }
}

/** §2.6 -- ports `stats.backfill_if_needed`；在 Hub DO 第一次 tick 時呼叫。 */
export async function backfillIfNeeded(db: D1Database): Promise<boolean> {
  try {
    if ((await queries.getSetting(db, BACKFILL_SETTING_KEY)) === "1") return false;

    const any = await db.prepare("SELECT 1 AS present FROM worker_job_stats LIMIT 1").first<{ present: number }>();
    if (any) {
      await queries.setSetting(db, BACKFILL_SETTING_KEY, "1");
      return false;
    }

    const { results } = await db
      .prepare(
        `SELECT r.worker_id AS worker_id, r.gpu_seconds AS gpu_seconds, r.created_at AS created_at,
                j.id AS job_id, j.signature AS signature, j.workflow_json AS workflow_json
         FROM receipts r JOIN jobs j ON j.id = r.job_id
         WHERE r.kind = 'completed' AND r.billable = 1
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .bind(BACKFILL_LIMIT)
      .all<{
        worker_id: string;
        gpu_seconds: number;
        created_at: string;
        job_id: string;
        signature: string | null;
        workflow_json: string;
      }>();

    const replay = [...results].reverse(); // 依 created_at 由舊到新

    for (const row of replay) {
      let signature = row.signature;
      if (!signature) {
        let workflow: unknown;
        try {
          workflow = JSON.parse(row.workflow_json || "{}");
        } catch {
          continue;
        }
        if (typeof workflow !== "object" || workflow === null) continue;
        const wf = workflow as Record<string, unknown>;
        signature = await computeSignature(wf, extract(wf));
        await db.prepare("UPDATE jobs SET signature = ? WHERE id = ?").bind(signature, row.job_id).run();
      }
      await recordCompletion(db, row.worker_id, signature, row.gpu_seconds, new Date(`${row.created_at}Z`));
    }

    await queries.setSetting(db, BACKFILL_SETTING_KEY, "1");
    return true;
  } catch (err) {
    console.error("stats: backfillIfNeeded failed", err);
    return false;
  }
}
```

- [ ] **Step 9: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠

- [ ] **Step 10: Commit**

```bash
git add server/comfyfed_server/stats.py server/comfyfed_server/app.py tests/server/test_stats.py cloud/src/core/stats.ts cloud/test/stats.spec.ts
git commit -F - <<'MSGEOF'
feat(scheduler): learn per-worker execution speed per job signature

Phase 3.3 Task 2. stats.py / core/stats.ts implement the spec's §2.3 EWMA +
speed_index update rules and the §2.4 predict basis ladder as pure functions
over plain rows, plus thin DB adapters. Python startup backfills from the last
500 completed billable receipts once, filling in missing job signatures on the
way; the cloud hooks the same backfill into its first tick in Task 4.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 3: 排程模組 scheduler — 成本模型 + Hungarian（兩棧）

**Files:**
- Create: `server/comfyfed_server/scheduler.py`
- Create: `cloud/src/core/scheduler.ts`
- Modify: `cloud/test/fixtures/scheduler_cases.json`（Task 1 建的檔，加入 `hungarian_cases` 與 `cost_cases`）
- Test: `tests/server/test_scheduler.py`（新檔）、`cloud/test/scheduler.spec.ts`（新檔）

**Interfaces:**
- Consumes: Task 2 的 `stats.predict(...) -> (seconds, basis)` / `predict(...) -> {seconds, basis}`（本模組不呼叫它，只吃它算好的秒數）；既有 `assess.find_model(inventory, name) -> (found, size_gb)` / `findModel(inventory, name)`。
- Produces（Task 4 依賴這些名字）：
  - Python：`scheduler.JobCandidate(job_id, signature, created_at, is_light, required_models)`、`scheduler.WorkerCandidate(worker_id, name, backend, free_vram_gb, warm_models, inventory)`、`scheduler.PairVerdict(kind, has_warnings, total_fetch_bytes)`（三個都是 frozen dataclass）；`scheduler.load_seconds(job, worker) -> float`；`scheduler.fetch_seconds(pair) -> float`；`scheduler.light_penalty(job, worker) -> float`；`scheduler.cost(job, worker, pair, predicted_seconds, tier1_exists) -> float`；`scheduler.objective(cost_value, wait_seconds) -> float`；`scheduler.build_matrix(jobs, workers, pairs, predictions, now) -> list[list[float]]`；`scheduler.solve(matrix) -> list[tuple[int, int]]`；`scheduler.match(jobs, workers, pairs, predictions, now) -> list[tuple[int, int]]`。常數 `LOAD_SEC_PER_GB=1.5`、`FETCH_BYTES_PER_SEC=50e6`、`STARVE_SECONDS=300`、`STARVE_BONUS=1e8`、`AGE_WEIGHT=1.0`、`BIG=1e9`、`WARN_PENALTY=1_000_000.0`、`LIGHT_BACKEND_PENALTY=60.0`、`LIGHT_VRAM_WEIGHT=5.0`。
  - TS：`export interface JobCandidate { jobId: string; signature: string | null; createdAt: Date; isLight: boolean; requiredModels: string[] }`；`export interface WorkerCandidate { workerId: string; name: string; backend: string; freeVramGb: number; warmModels: string[]; inventory: ModelInventoryEntry[] }`；`export interface PairVerdict { kind: string; hasWarnings: boolean; totalFetchBytes: number }`；`pairKey(jobId: string, workerId: string): string`；`loadSeconds(job, worker): number`；`fetchSeconds(pair): number`；`lightPenalty(job, worker): number`；`cost(job, worker, pair, predictedSeconds: number, tier1Exists: boolean): number`；`objective(costValue: number, waitSeconds: number): number`；`buildMatrix(jobs, workers, pairs: Map<string, PairVerdict>, predictions: Map<string, number>, now: Date): number[][]`；`solve(matrix: number[][]): [number, number][]`；`match(jobs, workers, pairs, predictions, now): [number, number][]`。

**設計註記（規格模糊處的解法，實作時照這個走）：**
`solve` 的「forbidden」定義是 **非有限值**（`Infinity`、`-Infinity`、`NaN`），不是「負值」。spec §5 說「NaN/負值 → 以 ∞ 處理」，講的是 §2.4 的**原始 cost**（成本本來就不該是負的，負的代表算錯了）；但送進 Hungarian 的是 §2.5 的**目標函數** `cost − AGE·wait − BIG`，那是刻意大幅為負的。所以：`cost()` 在任何一項是 NaN 或負數時回 `inf`，而 `solve()` 接受任何有限浮點數（含負數），只把非有限值當禁止。

- [ ] **Step 1: 寫失敗的 Python 測試**

Create `tests/server/test_scheduler.py`：

```python
"""Unit tests for scheduler.py -- Phase 3.3 §2.4 成本模型的每一項、§2.5 的
Hungarian（含長方矩陣、∞、決定性）、以及兩棧共用 fixture 的黃金值。
"""

import json
import math
import pathlib
from datetime import datetime, timedelta, timezone

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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_scheduler.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'comfyfed_server.scheduler'`

- [ ] **Step 3: 實作 `server/comfyfed_server/scheduler.py`**

```python
"""Phase 3.3 §2.4-§2.5: 成本模型與整體配對。

全部是純函數：不碰 DB、不讀時鐘（`now` 一律由呼叫端傳進來）。呼叫端
（`dispatch.assign_jobs`）負責把 DB 列翻成這裡的 `JobCandidate` /
`WorkerCandidate` / `PairVerdict`，再把結果翻回去做原子 claim。

兩棧逐行對照 `cloud/src/core/scheduler.ts`；任何一邊改了算式，另一邊必須
同一個 commit 一起改，共用 fixture `cloud/test/fixtures/scheduler_cases.json`
就是用來釘住這件事的。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Sequence

from . import assess

LOAD_SEC_PER_GB = 1.5
FETCH_BYTES_PER_SEC = 50e6
STARVE_SECONDS = 300
# 等待超過 STARVE_SECONDS 再多減這麼多，確保只要有合格 worker 一定本 tick 派出。
STARVE_BONUS = 1e8
AGE_WEIGHT = 1.0
BIG = 1e9
WARN_PENALTY = 1_000_000.0
LIGHT_BACKEND_PENALTY = 60.0
LIGHT_VRAM_WEIGHT = 5.0

_WEAK_BACKENDS = ("mps", "cpu")

# Hungarian 內部用的「禁止」哨兵。演算法裡會做 `a[i][j] - u[i] - v[j]` 這種
# 減法，真的塞 `inf` 會冒出 `inf - inf = NaN` 把整個 potential 弄壞，所以禁止
# 的格子換成一個大到絕不會被選中、但仍是有限值的數；選出來之後再回頭對照
# 原始矩陣把禁止格剔掉。
_FORBIDDEN_SENTINEL = 1e18


@dataclass(frozen=True)
class JobCandidate:
    """派工決策需要的 job 欄位，和 ORM 脫鉤。"""

    job_id: str
    signature: Optional[str]
    created_at: datetime
    # 無 required_models 且無 est_vram_gb -- 見 dispatch 的 `is_light`。
    is_light: bool
    required_models: tuple[str, ...]


@dataclass(frozen=True)
class WorkerCandidate:
    worker_id: str
    name: str
    backend: str
    free_vram_gb: float
    # 這台 worker 最近一次被指派的 job 的 required_models（§2.2）。
    warm_models: tuple[str, ...]
    # `assess.model_inventory(worker)` 的結果，用來查模型大小。
    inventory: tuple[dict, ...]


@dataclass(frozen=True)
class PairVerdict:
    """`assess.verdict` 對這一對 (job, worker) 的判定，壓成排程需要的三個值。"""

    kind: str  # "eligible" | "eligible_after_fetch" | "ineligible"
    has_warnings: bool
    total_fetch_bytes: int


def _finite(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def load_seconds(job: JobCandidate, worker: WorkerCandidate) -> float:
    """§2.4：這台 worker 還沒熱起來的模型，預估要花多久載進 VRAM。

    大小來自 worker 自己的 `model_inventory`（用 `assess.find_model` 比對，
    因為工作流的模型名和 inventory 路徑根目錄不同）；查不到大小視為 0，
    寧可低估也不要憑空捏一個數字進成本。
    """
    warm = set(worker.warm_models)
    total_gb = 0.0
    for name in job.required_models:
        if name in warm:
            continue
        _found, size_gb = assess.find_model(list(worker.inventory), name)
        if size_gb is not None:
            total_gb += float(size_gb)
    return total_gb * LOAD_SEC_PER_GB


def fetch_seconds(pair: PairVerdict) -> float:
    """§2.4：只有 `eligible_after_fetch` 才會 > 0（頻寬用常數，不量測）。"""
    if pair.kind != "eligible_after_fetch":
        return 0.0
    return float(pair.total_fetch_bytes) / FETCH_BYTES_PER_SEC


def light_penalty(job: JobCandidate, worker: WorkerCandidate) -> float:
    """§2.4：零模型工作落在大卡上要付的代價 -- 把大卡留給真的需要的工作。"""
    if not job.is_light:
        return 0.0
    backend_penalty = 0.0 if worker.backend in _WEAK_BACKENDS else LIGHT_BACKEND_PENALTY
    return backend_penalty + worker.free_vram_gb * LIGHT_VRAM_WEIGHT


def _legacy_tiebreak(job: JobCandidate, worker: WorkerCandidate) -> float:
    """只用來打破完全相等的舊排序鍵：輕工作偏小卡、重工作偏大卡。

    量級刻意做到小於 1 秒（重工作那側甚至小於 1 毫秒），所以它永遠不會蓋過
    任何一項真正的成本，只在兩邊其他每一項都一模一樣時說話。
    """
    if job.is_light:
        return worker.free_vram_gb / 1000.0
    return (1000.0 - worker.free_vram_gb) / 1e6


def cost(
    job: JobCandidate,
    worker: WorkerCandidate,
    pair: PairVerdict,
    predicted_seconds: float,
    tier1_exists: bool,
) -> float:
    """§2.4 的 `cost(j, w)`；不可用一律 `math.inf`。

    `tier1_exists` 是「這個 job 至少有一個 `eligible` 候選」-- 有的話，
    `eligible_after_fetch` 的候選對這個 job 一律視為不可用，保住「已經有模型
    的一定贏過要下載的」這個既有語意。

    任何一項算出 NaN 或負數也回 `inf`：成本本來就不該是負的，出現代表上游
    算錯了，寧可不派也不要讓一個壞值贏過所有合理選擇（spec §5）。
    """
    if pair.kind not in ("eligible", "eligible_after_fetch"):
        return math.inf
    if pair.kind == "eligible_after_fetch" and tier1_exists:
        return math.inf

    components = (
        predicted_seconds,
        load_seconds(job, worker),
        fetch_seconds(pair),
        light_penalty(job, worker),
        WARN_PENALTY if pair.has_warnings else 0.0,
        _legacy_tiebreak(job, worker),
    )
    total = 0.0
    for component in components:
        if not _finite(component) or component < 0:
            return math.inf
        total += float(component)
    return total


def objective(cost_value: float, wait_seconds: float) -> float:
    """§2.5 第 4 條的目標函數項。

    減掉 `BIG` 是為了讓「多派一件」永遠優於「少派一件」：任何一個真實配對的
    目標值都遠低於補零的那些格子，所以 Hungarian 在不違反禁止格的前提下一定
    會盡量多配對。
    """
    if not _finite(cost_value):
        return math.inf
    wait = wait_seconds if _finite(wait_seconds) and wait_seconds > 0 else 0.0
    value = cost_value - AGE_WEIGHT * wait - BIG
    if wait >= STARVE_SECONDS:
        value -= STARVE_BONUS
    return value


def build_matrix(
    jobs: Sequence[JobCandidate],
    workers: Sequence[WorkerCandidate],
    pairs: dict[tuple[str, str], PairVerdict],
    predictions: dict[tuple[str, str], float],
    now: datetime,
) -> list[list[float]]:
    """`matrix[i][j]` = job i 派給 worker j 的目標值；不可用為 `math.inf`。

    `pairs` / `predictions` 以 `(job_id, worker_id)` 為鍵；缺鍵視為不可用／
    使用預設 60 秒（`predictions` 缺鍵只可能是呼叫端漏算，不該讓整個 tick
    掛掉）。
    """
    tier1 = {
        job.job_id: any(
            pairs.get((job.job_id, worker.worker_id), PairVerdict("ineligible", False, 0)).kind
            == "eligible"
            for worker in workers
        )
        for job in jobs
    }

    matrix: list[list[float]] = []
    for job in jobs:
        wait_seconds = (now - job.created_at).total_seconds()
        row: list[float] = []
        for worker in workers:
            pair = pairs.get((job.job_id, worker.worker_id))
            if pair is None:
                row.append(math.inf)
                continue
            predicted = predictions.get((job.job_id, worker.worker_id), 60.0)
            row.append(
                objective(cost(job, worker, pair, predicted, tier1[job.job_id]), wait_seconds)
            )
        matrix.append(row)
    return matrix


def solve(matrix: list[list[float]]) -> list[tuple[int, int]]:
    """最小成本配對（Kuhn–Munkres / Hungarian，O(n³)）。

    長方形輸入會內部補 0 成方陣。非有限值（`inf`、`-inf`、`NaN`）視為禁止，
    最後回傳時剔除；有限負值完全合法（目標函數刻意是負的）。回傳依 row 排序
    的 `(row, col)`，不含補零的行列。

    決定性：在固定的輸入順序下，內層挑 `delta` 用的是嚴格小於，所以平手時
    永遠選欄位索引最小的那個；TS 版逐行相同，因此兩棧同一個矩陣得到同一組
    配對。呼叫端要先把 jobs 依 `(created_at, job_id)`、workers 依
    `(name, worker_id)` 排好，這個保證才有意義。
    """
    rows_n = len(matrix)
    cols_n = max((len(row) for row in matrix), default=0)
    n = max(rows_n, cols_n)
    if n == 0:
        return []

    # 1-indexed 工作矩陣。
    a = [[0.0] * (n + 1) for _ in range(n + 1)]
    for i in range(n):
        for j in range(n):
            value = 0.0
            if i < rows_n and j < len(matrix[i]):
                raw = matrix[i][j]
                value = float(raw) if _finite(raw) else _FORBIDDEN_SENTINEL
            a[i + 1][j + 1] = value

    inf = math.inf
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)
    way = [0] * (n + 1)

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = 0
            for j in range(1, n + 1):
                if used[j]:
                    continue
                cur = a[i0][j] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(0, n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    result: list[tuple[int, int]] = []
    for j in range(1, n + 1):
        i = p[j]
        if i == 0:
            continue
        row, col = i - 1, j - 1
        if row >= rows_n or col >= cols_n or col >= len(matrix[row]):
            continue
        if not _finite(matrix[row][col]):
            continue
        result.append((row, col))
    result.sort()
    return result


def match(
    jobs: Sequence[JobCandidate],
    workers: Sequence[WorkerCandidate],
    pairs: dict[tuple[str, str], PairVerdict],
    predictions: dict[tuple[str, str], float],
    now: datetime,
) -> list[tuple[int, int]]:
    """`build_matrix` + `solve` 的便利包裝：回傳 `(job index, worker index)`。"""
    return solve(build_matrix(jobs, workers, pairs, predictions, now))
```

- [ ] **Step 4: 建立 fixture 的 hungarian / cost 案例**

把 `cloud/test/fixtures/scheduler_cases.json` 改成（保留 Task 1 已經填好 `expected` 的 `signature_cases`，只新增兩個陣列；矩陣裡的 `null` 代表 `Infinity`，因為 JSON 沒有 `Infinity` 字面值）：

```json
{
  "signature_cases": [ "... Task 1 已填好的內容原封不動 ..." ],
  "hungarian_cases": [
    {
      "name": "known optimal 4x4",
      "matrix": [
        [82, 83, 69, 92],
        [77, 37, 49, 92],
        [11, 69, 5, 86],
        [8, 9, 98, 23]
      ],
      "expected_pairs": []
    },
    {
      "name": "3 jobs x 5 workers with forbidden cells",
      "matrix": [
        [10, null, 30, 40, 50],
        [null, 20, 35, 45, 55],
        [60, 70, 15, 80, 90]
      ],
      "expected_pairs": []
    },
    {
      "name": "all forbidden",
      "matrix": [
        [null, null],
        [null, null]
      ],
      "expected_pairs": []
    },
    {
      "name": "negative objective values (cost minus BIG)",
      "matrix": [
        [-999999995.0, -999999950.0],
        [-999999960.0, -999999990.0]
      ],
      "expected_pairs": []
    },
    {
      "name": "all ties",
      "matrix": [
        [1, 1],
        [1, 1]
      ],
      "expected_pairs": []
    }
  ],
  "cost_cases": [
    {
      "name": "heavy job, one cold 6 GB model, 24 GB free",
      "job": {
        "job_id": "j1",
        "signature": "sig",
        "created_at": "2026-09-15T12:00:00",
        "is_light": false,
        "required_models": ["flux1-dev.safetensors"]
      },
      "worker": {
        "worker_id": "w1",
        "name": "w1",
        "backend": "cuda",
        "free_vram_gb": 24.0,
        "warm_models": [],
        "inventory": [{ "name": "unet/flux1-dev.safetensors", "size": 6.0 }]
      },
      "pair": { "kind": "eligible", "has_warnings": false, "total_fetch_bytes": 0 },
      "predicted_seconds": 40.0,
      "tier1_exists": true,
      "expected_cost": 0
    },
    {
      "name": "light job on a big cuda card",
      "job": {
        "job_id": "j2",
        "signature": null,
        "created_at": "2026-09-15T12:00:00",
        "is_light": true,
        "required_models": []
      },
      "worker": {
        "worker_id": "w2",
        "name": "w2",
        "backend": "cuda",
        "free_vram_gb": 32.0,
        "warm_models": [],
        "inventory": []
      },
      "pair": { "kind": "eligible", "has_warnings": false, "total_fetch_bytes": 0 },
      "predicted_seconds": 12.0,
      "tier1_exists": true,
      "expected_cost": 0
    },
    {
      "name": "warned fetch candidate with no tier-1 rival",
      "job": {
        "job_id": "j3",
        "signature": "sig",
        "created_at": "2026-09-15T12:00:00",
        "is_light": false,
        "required_models": ["big.safetensors"]
      },
      "worker": {
        "worker_id": "w3",
        "name": "w3",
        "backend": "cuda",
        "free_vram_gb": 8.0,
        "warm_models": [],
        "inventory": []
      },
      "pair": { "kind": "eligible_after_fetch", "has_warnings": true, "total_fetch_bytes": 500000000 },
      "predicted_seconds": 60.0,
      "tier1_exists": false,
      "expected_cost": 0
    }
  ]
}
```

然後用 Python 把 `expected_pairs` / `expected_cost` 填成真值：

```bash
.venv/Scripts/python.exe - <<'PY'
import json, math, pathlib, sys
from datetime import datetime
sys.path.insert(0, "server")
from comfyfed_server import scheduler
p = pathlib.Path("cloud/test/fixtures/scheduler_cases.json")
data = json.loads(p.read_text(encoding="utf-8"))
for case in data["hungarian_cases"]:
    matrix = [[math.inf if v is None else float(v) for v in row] for row in case["matrix"]]
    case["expected_pairs"] = [list(pair) for pair in scheduler.solve(matrix)]
for case in data["cost_cases"]:
    j, w, pr = case["job"], case["worker"], case["pair"]
    job = scheduler.JobCandidate(j["job_id"], j["signature"], datetime.fromisoformat(j["created_at"]), j["is_light"], tuple(j["required_models"]))
    worker = scheduler.WorkerCandidate(w["worker_id"], w["name"], w["backend"], w["free_vram_gb"], tuple(w["warm_models"]), tuple(w["inventory"]))
    pair = scheduler.PairVerdict(pr["kind"], pr["has_warnings"], pr["total_fetch_bytes"])
    case["expected_cost"] = scheduler.cost(job, worker, pair, case["predicted_seconds"], case["tier1_exists"])
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"hungarian": [c["expected_pairs"] for c in data["hungarian_cases"]], "cost": [c["expected_cost"] for c in data["cost_cases"]]}, indent=2))
PY
```

檢查印出來的值合理（4×4 是四對且總成本 140、3×5 是 `[[0,0],[1,1],[2,2]]`、all forbidden 是 `[]`），再往下走。

- [ ] **Step 5: 跑 Python 測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_scheduler.py -q`
Expected: PASS

- [ ] **Step 6: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 7: 寫 cloud scheduler 測試**

Create `cloud/test/scheduler.spec.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as scheduler from "../src/core/scheduler";
import fixtures from "./fixtures/scheduler_cases.json";

const NOW = new Date("2026-09-15T12:00:00Z");

function job(
  jobId = "j1",
  opts: { isLight?: boolean; models?: string[]; createdAt?: Date } = {}
): scheduler.JobCandidate {
  return {
    jobId,
    signature: "sig",
    createdAt: opts.createdAt ?? NOW,
    isLight: opts.isLight ?? false,
    requiredModels: opts.models ?? [],
  };
}

function worker(
  workerId = "w1",
  opts: { backend?: string; freeVramGb?: number; warm?: string[]; inventory?: unknown[] } = {}
): scheduler.WorkerCandidate {
  return {
    workerId,
    name: workerId,
    backend: opts.backend ?? "cuda",
    freeVramGb: opts.freeVramGb ?? 24,
    warmModels: opts.warm ?? [],
    inventory: (opts.inventory ?? []) as any,
  };
}

function pair(kind = "eligible", hasWarnings = false, totalFetchBytes = 0): scheduler.PairVerdict {
  return { kind, hasWarnings, totalFetchBytes };
}

function pairMap(entries: [string, string, scheduler.PairVerdict][]): Map<string, scheduler.PairVerdict> {
  return new Map(entries.map(([j, w, v]) => [scheduler.pairKey(j, w), v]));
}

function predMap(entries: [string, string, number][]): Map<string, number> {
  return new Map(entries.map(([j, w, v]) => [scheduler.pairKey(j, w), v]));
}

describe("loadSeconds", () => {
  it("is zero when every model is already warm", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", {
      warm: ["flux1-dev.safetensors"],
      inventory: [{ name: "diffusion_models/flux1-dev.safetensors", size: 22 }],
    });
    expect(scheduler.loadSeconds(j, w)).toBe(0);
  });

  it("charges 1.5 seconds per GB of cold models", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", { inventory: [{ name: "diffusion_models/flux1-dev.safetensors", size: 6 }] });
    expect(scheduler.loadSeconds(j, w)).toBeCloseTo(9, 10);
  });

  it("treats an unknown size as zero", () => {
    const j = job("j1", { models: ["mystery.safetensors"] });
    const w = worker("w1", { inventory: [{ name: "loras/mystery.safetensors" }] });
    expect(scheduler.loadSeconds(j, w)).toBe(0);
  });

  it("sums every cold model", () => {
    const j = job("j1", { models: ["a.safetensors", "b.safetensors"] });
    const w = worker("w1", {
      warm: ["a.safetensors"],
      inventory: [
        { name: "unet/a.safetensors", size: 10 },
        { name: "vae/b.safetensors", size: 2 },
      ],
    });
    expect(scheduler.loadSeconds(j, w)).toBeCloseTo(3, 10);
  });
});

describe("fetchSeconds", () => {
  it("is zero for a directly eligible pair", () => expect(scheduler.fetchSeconds(pair())).toBe(0));
  it("divides by 50 MB/s", () =>
    expect(scheduler.fetchSeconds(pair("eligible_after_fetch", false, 500_000_000))).toBeCloseTo(10, 10));
});

describe("lightPenalty", () => {
  it("is zero for a heavy job", () =>
    expect(scheduler.lightPenalty(job("j1"), worker("w1", { freeVramGb: 32 }))).toBe(0));
  it("punishes a real GPU and scales with free VRAM", () =>
    expect(scheduler.lightPenalty(job("j1", { isLight: true }), worker("w1", { freeVramGb: 32 }))).toBeCloseTo(220, 10));
  it("lets a weak backend off the 60 second charge", () =>
    expect(
      scheduler.lightPenalty(job("j1", { isLight: true }), worker("w1", { backend: "mps", freeVramGb: 0 }))
    ).toBe(0));
});

describe("cost", () => {
  it("sums every component plus the legacy tiebreak", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", { freeVramGb: 24, inventory: [{ name: "unet/flux1-dev.safetensors", size: 6 }] });
    expect(scheduler.cost(j, w, pair(), 40, true)).toBeCloseTo(40 + 9 + 0.000976, 9);
  });

  it("adds a million for a warned verdict", () => {
    const j = job();
    const w = worker("w1", { freeVramGb: 24 });
    const clean = scheduler.cost(j, w, pair(), 40, true);
    const warned = scheduler.cost(j, w, pair("eligible", true), 40, true);
    expect(warned - clean).toBeCloseTo(scheduler.WARN_PENALTY, 6);
  });

  it("prefers the smaller card for a light job's tiebreak", () => {
    const j = job("j1", { isLight: true });
    const small = scheduler.cost(j, worker("w_small", { freeVramGb: 8 }), pair(), 40, true);
    const big = scheduler.cost(j, worker("w_big", { freeVramGb: 8.0001 }), pair(), 40, true);
    expect(small).toBeLessThan(big);
  });

  it("is infinite for an ineligible pair", () =>
    expect(scheduler.cost(job(), worker(), pair("ineligible"), 40, true)).toBe(Infinity));

  it("is infinite for a fetch candidate when a tier-1 candidate exists", () => {
    const p = pair("eligible_after_fetch", false, 10);
    expect(scheduler.cost(job(), worker(), p, 40, true)).toBe(Infinity);
    expect(Number.isFinite(scheduler.cost(job(), worker(), p, 40, false))).toBe(true);
  });

  it("is infinite when any component is NaN or negative", () => {
    expect(scheduler.cost(job(), worker(), pair(), NaN, true)).toBe(Infinity);
    expect(scheduler.cost(job(), worker(), pair(), -1, true)).toBe(Infinity);
  });
});

describe("objective", () => {
  it("subtracts BIG so assigning always beats idling", () =>
    expect(scheduler.objective(100, 0)).toBeCloseTo(100 - scheduler.BIG, 6));
  it("rewards waiting one second per second", () =>
    expect(scheduler.objective(100, 30)).toBeCloseTo(100 - 30 - scheduler.BIG, 6));
  it("adds the starvation bonus past 300 seconds", () => {
    const starved = scheduler.objective(100, scheduler.STARVE_SECONDS);
    const fresh = scheduler.objective(100, scheduler.STARVE_SECONDS - 1);
    expect(fresh - starved).toBeCloseTo(scheduler.STARVE_BONUS + 1, 0);
  });
  it("keeps infinity infinite", () => expect(scheduler.objective(Infinity, 9999)).toBe(Infinity));
});

describe("solve (Hungarian)", () => {
  it("returns nothing for an empty matrix", () => expect(scheduler.solve([])).toEqual([]));

  it("finds the known optimum of a 4x4", () => {
    const matrix = [
      [82, 83, 69, 92],
      [77, 37, 49, 92],
      [11, 69, 5, 86],
      [8, 9, 98, 23],
    ];
    const pairs = scheduler.solve(matrix);
    expect(pairs).toHaveLength(4);
    expect(pairs.map(([r]) => r).sort()).toEqual([0, 1, 2, 3]);
    expect(pairs.map(([, c]) => c).sort()).toEqual([0, 1, 2, 3]);
    const total = pairs.reduce((sum, [r, c]) => sum + matrix[r]![c]!, 0);
    expect(total).toBeCloseTo(140, 10);
  });

  it("handles 3 jobs x 5 workers and avoids forbidden cells", () => {
    const matrix = [
      [10, Infinity, 30, 40, 50],
      [Infinity, 20, 35, 45, 55],
      [60, 70, 15, 80, 90],
    ];
    expect(scheduler.solve(matrix)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("drops every pair when the matrix is all forbidden", () => {
    expect(scheduler.solve([[Infinity, Infinity], [Infinity, Infinity]])).toEqual([]);
  });

  it("treats NaN as forbidden", () => {
    expect(scheduler.solve([[NaN, 5], [5, NaN]])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("accepts finite negative costs", () => {
    expect(scheduler.solve([[-1e9 + 5, -1e9 + 50], [-1e9 + 40, -1e9 + 10]])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("is deterministic on ties", () => {
    const matrix = [[1, 1], [1, 1]];
    expect(scheduler.solve(matrix)).toEqual(scheduler.solve(matrix));
    expect(scheduler.solve(matrix)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("match", () => {
  it("gives two heavy jobs one card each instead of the same card", () => {
    const jobs = [job("j1"), job("j2")];
    const workers = [worker("w_big", { freeVramGb: 32 }), worker("w_small", { freeVramGb: 12 })];
    const pairs = pairMap(jobs.flatMap((j) => workers.map((w) => [j.jobId, w.workerId, pair()] as [string, string, scheduler.PairVerdict])));
    const preds = predMap(jobs.flatMap((j) => workers.map((w) => [j.jobId, w.workerId, 40] as [string, string, number])));
    const result = scheduler.match(jobs, workers, pairs, preds, NOW);
    expect(result).toHaveLength(2);
    expect(result.map(([, c]) => c).sort()).toEqual([0, 1]);
  });

  it("prefers the warm cache over a bigger but cold card", () => {
    const jobs = [job("j1", { models: ["flux1-dev.safetensors"] })];
    const workers = [
      worker("w_warm", { freeVramGb: 16, warm: ["flux1-dev.safetensors"], inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
      worker("w_cold", { freeVramGb: 48, inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
    ];
    const pairs = pairMap(workers.map((w) => ["j1", w.workerId, pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap(workers.map((w) => ["j1", w.workerId, 40] as [string, string, number]));
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 0]]);
  });

  it("prefers the historically faster worker", () => {
    const jobs = [job("j1")];
    const workers = [worker("w_slow"), worker("w_fast")];
    const pairs = pairMap(workers.map((w) => ["j1", w.workerId, pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap([["j1", "w_slow", 90], ["j1", "w_fast", 30]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 1]]);
  });

  it("prefers a clean worker over a warned one", () => {
    const jobs = [job("j1")];
    const workers = [worker("w_warn", { freeVramGb: 48 }), worker("w_clean", { freeVramGb: 8 })];
    const pairs = pairMap([
      ["j1", "w_warn", pair("eligible", true)],
      ["j1", "w_clean", pair()],
    ]);
    const preds = predMap([["j1", "w_warn", 10], ["j1", "w_clean", 40]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 1]]);
  });

  it("prefers a worker that already has the model over one that must download", () => {
    const jobs = [job("j1", { models: ["flux1-dev.safetensors"] })];
    const workers = [
      worker("w_have", { freeVramGb: 8, inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
      worker("w_fetch", { freeVramGb: 48 }),
    ];
    const pairs = pairMap([
      ["j1", "w_have", pair()],
      ["j1", "w_fetch", pair("eligible_after_fetch", false, 1)],
    ]);
    const preds = predMap([["j1", "w_have", 40], ["j1", "w_fetch", 1]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 0]]);
  });

  it("lets a starved job jump a fresh one for the only worker", () => {
    const starved = job("j_old", { createdAt: new Date(NOW.getTime() - (scheduler.STARVE_SECONDS + 10) * 1000) });
    const fresh = job("j_new");
    const jobs = [fresh, starved];
    const workers = [worker("w1")];
    const pairs = pairMap(jobs.map((j) => [j.jobId, "w1", pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap(jobs.map((j) => [j.jobId, "w1", 40] as [string, string, number]));
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[1, 0]]);
  });
});

describe("shared fixture parity", () => {
  it("solves every hungarian case exactly like Python does", () => {
    for (const c of (fixtures as any).hungarian_cases) {
      const matrix = (c.matrix as (number | null)[][]).map((row) => row.map((v) => (v === null ? Infinity : v)));
      expect(scheduler.solve(matrix), c.name).toEqual(c.expected_pairs.map((p: number[]) => [p[0], p[1]]));
    }
  });

  it("costs every case exactly like Python does", () => {
    for (const c of (fixtures as any).cost_cases) {
      const j: scheduler.JobCandidate = {
        jobId: c.job.job_id,
        signature: c.job.signature,
        createdAt: new Date(`${c.job.created_at}Z`),
        isLight: c.job.is_light,
        requiredModels: c.job.required_models,
      };
      const w: scheduler.WorkerCandidate = {
        workerId: c.worker.worker_id,
        name: c.worker.name,
        backend: c.worker.backend,
        freeVramGb: c.worker.free_vram_gb,
        warmModels: c.worker.warm_models,
        inventory: c.worker.inventory,
      };
      const p: scheduler.PairVerdict = {
        kind: c.pair.kind,
        hasWarnings: c.pair.has_warnings,
        totalFetchBytes: c.pair.total_fetch_bytes,
      };
      expect(scheduler.cost(j, w, p, c.predicted_seconds, c.tier1_exists), c.name).toBeCloseTo(c.expected_cost, 9);
    }
  });
});
```

- [ ] **Step 8: 實作 `cloud/src/core/scheduler.ts`**

```ts
/**
 * Phase 3.3 §2.4-§2.5: 成本模型與整體配對。
 * Parity source: `server/comfyfed_server/scheduler.py` -- 全部是純函數，不碰
 * D1、不讀時鐘（`now` 由呼叫端傳）。任何一邊改了算式，另一邊必須同一個
 * commit 一起改；`cloud/test/fixtures/scheduler_cases.json` 就是釘住這件事的
 * 共用黃金 fixture。
 */

import { findModel } from "./assess";
import type { ModelInventoryEntry } from "../db/queries";

export const LOAD_SEC_PER_GB = 1.5;
export const FETCH_BYTES_PER_SEC = 50e6;
export const STARVE_SECONDS = 300;
/** 等待超過 STARVE_SECONDS 再多減這麼多，確保只要有合格 worker 一定本 tick 派出。 */
export const STARVE_BONUS = 1e8;
export const AGE_WEIGHT = 1.0;
export const BIG = 1e9;
export const WARN_PENALTY = 1_000_000.0;
export const LIGHT_BACKEND_PENALTY = 60.0;
export const LIGHT_VRAM_WEIGHT = 5.0;

const WEAK_BACKENDS = ["mps", "cpu"];

/** Hungarian 內部用的「禁止」哨兵 -- 見 scheduler.py 的 `_FORBIDDEN_SENTINEL`
 * 註解：真的塞 Infinity 會在 `a[i][j] - u[i] - v[j]` 冒出 NaN。 */
const FORBIDDEN_SENTINEL = 1e18;

export interface JobCandidate {
  jobId: string;
  signature: string | null;
  createdAt: Date;
  /** 無 required_models 且無 est_vram_gb。 */
  isLight: boolean;
  requiredModels: string[];
}

export interface WorkerCandidate {
  workerId: string;
  name: string;
  backend: string;
  freeVramGb: number;
  /** 最近一次被指派的 job 的 required_models（§2.2）。 */
  warmModels: string[];
  inventory: ModelInventoryEntry[];
}

export interface PairVerdict {
  kind: string; // "eligible" | "eligible_after_fetch" | "ineligible"
  hasWarnings: boolean;
  totalFetchBytes: number;
}

/** `pairs` / `predictions` 的鍵。TS 沒有 tuple key，用一個不可能出現在 id 裡
 * 的 NUL 分隔字串取代 Python 的 `(job_id, worker_id)`。 */
export function pairKey(jobId: string, workerId: string): string {
  return `${jobId}\u0000${workerId}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** §2.4 -- ports `scheduler.load_seconds`. */
export function loadSeconds(job: JobCandidate, worker: WorkerCandidate): number {
  const warm = new Set(worker.warmModels);
  let totalGb = 0;
  for (const name of job.requiredModels) {
    if (warm.has(name)) continue;
    const [, sizeGb] = findModel(worker.inventory, name);
    if (sizeGb !== null) totalGb += sizeGb;
  }
  return totalGb * LOAD_SEC_PER_GB;
}

/** §2.4 -- ports `scheduler.fetch_seconds`. */
export function fetchSeconds(pair: PairVerdict): number {
  if (pair.kind !== "eligible_after_fetch") return 0;
  return pair.totalFetchBytes / FETCH_BYTES_PER_SEC;
}

/** §2.4 -- ports `scheduler.light_penalty`. */
export function lightPenalty(job: JobCandidate, worker: WorkerCandidate): number {
  if (!job.isLight) return 0;
  const backendPenalty = WEAK_BACKENDS.includes(worker.backend) ? 0 : LIGHT_BACKEND_PENALTY;
  return backendPenalty + worker.freeVramGb * LIGHT_VRAM_WEIGHT;
}

/** 只用來打破完全相等的舊排序鍵 -- ports `scheduler._legacy_tiebreak`. */
function legacyTiebreak(job: JobCandidate, worker: WorkerCandidate): number {
  if (job.isLight) return worker.freeVramGb / 1000;
  return (1000 - worker.freeVramGb) / 1e6;
}

/** §2.4 的 `cost(j, w)` -- ports `scheduler.cost`；不可用一律 Infinity。 */
export function cost(
  job: JobCandidate,
  worker: WorkerCandidate,
  pair: PairVerdict,
  predictedSeconds: number,
  tier1Exists: boolean
): number {
  if (pair.kind !== "eligible" && pair.kind !== "eligible_after_fetch") return Infinity;
  if (pair.kind === "eligible_after_fetch" && tier1Exists) return Infinity;

  const components = [
    predictedSeconds,
    loadSeconds(job, worker),
    fetchSeconds(pair),
    lightPenalty(job, worker),
    pair.hasWarnings ? WARN_PENALTY : 0,
    legacyTiebreak(job, worker),
  ];
  let total = 0;
  for (const component of components) {
    if (!finite(component) || component < 0) return Infinity;
    total += component;
  }
  return total;
}

/** §2.5 第 4 條 -- ports `scheduler.objective`. */
export function objective(costValue: number, waitSeconds: number): number {
  if (!finite(costValue)) return Infinity;
  const wait = finite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 0;
  let value = costValue - AGE_WEIGHT * wait - BIG;
  if (wait >= STARVE_SECONDS) value -= STARVE_BONUS;
  return value;
}

/** Ports `scheduler.build_matrix`. */
export function buildMatrix(
  jobs: JobCandidate[],
  workers: WorkerCandidate[],
  pairs: Map<string, PairVerdict>,
  predictions: Map<string, number>,
  now: Date
): number[][] {
  const tier1 = new Map<string, boolean>();
  for (const job of jobs) {
    tier1.set(
      job.jobId,
      workers.some((w) => pairs.get(pairKey(job.jobId, w.workerId))?.kind === "eligible")
    );
  }

  return jobs.map((job) => {
    const waitSeconds = (now.getTime() - job.createdAt.getTime()) / 1000;
    return workers.map((worker) => {
      const pair = pairs.get(pairKey(job.jobId, worker.workerId));
      if (!pair) return Infinity;
      const predicted = predictions.get(pairKey(job.jobId, worker.workerId)) ?? 60;
      return objective(cost(job, worker, pair, predicted, tier1.get(job.jobId)!), waitSeconds);
    });
  });
}

/**
 * 最小成本配對（Kuhn–Munkres / Hungarian，O(n³)）-- ports `scheduler.solve`
 * 逐行。長方形輸入內部補 0 成方陣；非有限值（Infinity / -Infinity / NaN）
 * 視為禁止並在回傳前剔除；有限負值完全合法（目標函數刻意是負的）。
 *
 * 決定性：挑 `delta` 用嚴格小於，平手時永遠選欄位索引最小的那個，和 Python
 * 版一致。呼叫端要先把 jobs 依 `(createdAt, jobId)`、workers 依
 * `(name, workerId)` 排好，這個保證才有意義。
 */
export function solve(matrix: number[][]): [number, number][] {
  const rowsN = matrix.length;
  const colsN = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const n = Math.max(rowsN, colsN);
  if (n === 0) return [];

  // 1-indexed 工作矩陣。
  const a: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let value = 0;
      if (i < rowsN && j < matrix[i]!.length) {
        const raw = matrix[i]![j]!;
        value = finite(raw) ? raw : FORBIDDEN_SENTINEL;
      }
      a[i + 1]![j + 1] = value;
    }
  }

  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    for (;;) {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0]![j]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
      if (p[j0] === 0) break;
    }
    for (;;) {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
      if (j0 === 0) break;
    }
  }

  const result: [number, number][] = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j]!;
    if (i === 0) continue;
    const row = i - 1;
    const col = j - 1;
    if (row >= rowsN || col >= colsN || col >= matrix[row]!.length) continue;
    if (!finite(matrix[row]![col]!)) continue;
    result.push([row, col]);
  }
  result.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return result;
}

/** `buildMatrix` + `solve` -- ports `scheduler.match`. */
export function match(
  jobs: JobCandidate[],
  workers: WorkerCandidate[],
  pairs: Map<string, PairVerdict>,
  predictions: Map<string, number>,
  now: Date
): [number, number][] {
  return solve(buildMatrix(jobs, workers, pairs, predictions, now));
}
```

> `findModel` 目前的回傳型別是 `[boolean, number | null]`（`cloud/src/core/assess.ts:195`）。
> 若實際簽名不同（例如回傳物件），照它真正的形狀調整 `loadSeconds`，不要改
> `findModel` 本身。

- [ ] **Step 9: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠。若 `shared fixture parity` 失敗，先比對兩邊 `solve` 的逐行實作（最常見的錯是 `minv[j] < delta` 寫成 `<=`，會破壞決定性）。

- [ ] **Step 10: Commit**

```bash
git add server/comfyfed_server/scheduler.py tests/server/test_scheduler.py cloud/src/core/scheduler.ts cloud/test/scheduler.spec.ts cloud/test/fixtures/scheduler_cases.json
git commit -F - <<'MSGEOF'
feat(scheduler): cost model + Hungarian matching as pure functions

Phase 3.3 Task 3. scheduler.py / core/scheduler.ts implement the spec's §2.4
cost model (predicted exec, model load, fetch, light-job penalty, warning
penalty, legacy tiebreak, tier-1-beats-fetch rule) and the §2.5 objective plus
an O(n^3) Kuhn-Munkres solver over a padded square matrix with non-finite
cells treated as forbidden. A shared golden fixture pins both stacks to
byte-identical matching decisions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 4: 把排程器接進派工（兩棧）

**Files:**
- Modify: `server/comfyfed_server/dispatch.py:46-208`（整個 `assign_jobs`）
- Modify: `server/comfyfed_server/agentws.py:670-707`（`_handle_job_done`）、`:1185-1253`（`_create_and_push_receipt` 鄰近處新增 `_record_job_stats`）
- Modify: `cloud/src/core/dispatch.ts:81-169`（整個 `assignJobs`）
- Modify: `cloud/src/db/queries.ts:713-736`（`getQueuedJobsOrderedByCreatedAt` / `claimJob`）＋新增 `setWorkerWarmModels`
- Modify: `cloud/src/do/hub.ts:1171-1213`（`handleJobDone`）、`:1544-1560`（`tick()` 開頭掛回填）
- Test: `tests/server/test_dispatch.py`（新增語意測試）、`cloud/test/dispatch.spec.ts`（同）

**Interfaces:**
- Consumes: Task 2 的 `stats.load_rows()`、`stats.load_speed_index()`、`stats.predict(rows, speed_index, signature, worker_id) -> (seconds, basis)`、`stats.record_completion(worker_id, signature, exec_seconds)`、`stats.backfill_if_needed()`；cloud 的 `stats.loadRows(db)`、`stats.loadSpeedIndex(db)`、`stats.predict(...) -> {seconds, basis}`、`stats.recordCompletion(db, workerId, signature, execSeconds, now)`、`stats.backfillIfNeeded(db)`。Task 3 的 `scheduler.JobCandidate` / `WorkerCandidate` / `PairVerdict` / `match(jobs, workers, pairs, predictions, now)` / `STARVE_SECONDS`；cloud 的同名 export 加 `pairKey(jobId, workerId)`。
- Produces: `dispatch.assign_jobs(idle_worker_ids, fetchable_models=None, peer_only_models=None) -> list[tuple[str, db.Job]]`（簽名不變）；`assignJobs(db, idleWorkerIds, fetchableModels?, peerOnlyModels?, now?) -> Promise<Assignment[]>`（多一個可選 `now: Date`，預設 `new Date()`）；`queries.claimJob(db, jobId, workerId, dispatchInfo?: string)`；`queries.setWorkerWarmModels(db, workerId, models: string[])`；`queries.getQueuedJobsForDispatch(db)`。

- [ ] **Step 1: 寫失敗的 Python 語意測試**

在 `tests/server/test_dispatch.py` 的 `test_assign_jobs_fetch_tier_still_prefers_clean_over_warned`（第 704 行起）之後加入：

```python
# --- Phase 3.3 Task 4: 排程器語意 -----------------------------------------


def _set_stats(worker_id, signature, ewma_seconds, samples=3):
    with db.get_session() as session:
        session.add(
            db.WorkerJobStats(
                worker_id=worker_id,
                signature=signature,
                ewma_seconds=ewma_seconds,
                samples=samples,
            )
        )
        session.commit()


def _make_signed_job(job_id="j1", signature="sig", models=(), est_vram_gb=None, created_at=None):
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json="{}",
                status="queued",
                signature=signature,
                required_models=json.dumps(list(models)),
                est_vram_gb=est_vram_gb,
                **({"created_at": created_at} if created_at is not None else {}),
            )
        )
        session.commit()
    return job_id


def test_assign_jobs_prefers_a_warm_cache_over_a_bigger_but_cold_card(_db):
    """熱快取親和贏過 VRAM 較大但要重載（spec §6）。"""
    inventory = [{"name": "diffusion_models/flux1-dev.safetensors", "size": 22.0}]
    warm = _make_worker("w_warm", dynamic={"free_vram_gb": 16}, model_inventory=inventory)
    cold = _make_worker("w_cold", dynamic={"free_vram_gb": 48}, model_inventory=inventory)
    with db.get_session() as session:
        session.get(db.Worker, warm).warm_models = json.dumps(["flux1-dev.safetensors"])
        session.commit()

    job_id = _make_signed_job(models=("flux1-dev.safetensors",))

    assignments = dispatch.assign_jobs([warm, cold])

    assert [(w, j.id) for w, j in assignments] == [(warm, job_id)]


def test_assign_jobs_prefers_the_historically_faster_worker(_db):
    """歷史速度快者贏（spec §6）：兩台硬體看起來一樣，但一台跑這個簽章
    只要 30 秒、另一台要 90 秒。"""
    slow = _make_worker("w_slow", dynamic={"free_vram_gb": 24})
    fast = _make_worker("w_fast", dynamic={"free_vram_gb": 24})
    _set_stats(slow, "sig", 90.0)
    _set_stats(fast, "sig", 30.0)
    job_id = _make_signed_job()

    assignments = dispatch.assign_jobs([slow, fast])

    assert [(w, j.id) for w, j in assignments] == [(fast, job_id)]


def test_assign_jobs_spreads_two_heavy_jobs_across_two_cards(_db):
    """兩件重工作兩台卡各派一件而非同一台（spec §6）-- 舊的逐 job 貪婪演算法
    也做得到「一台一件」，這個測試真正釘住的是兩件都在同一個 tick 派出去，
    而且分別落在不同的卡上。"""
    big = _make_worker("w_big", dynamic={"free_vram_gb": 48})
    small = _make_worker("w_small", dynamic={"free_vram_gb": 24})
    now = _utcnow()
    _make_signed_job("j1", est_vram_gb=10, created_at=now - timedelta(seconds=10))
    _make_signed_job("j2", est_vram_gb=10, created_at=now)

    assignments = dispatch.assign_jobs([big, small])

    assert len(assignments) == 2
    assert {w for w, _j in assignments} == {big, small}
    assert {j.id for _w, j in assignments} == {"j1", "j2"}


def test_assign_jobs_writes_dispatch_info_and_warm_models(_db):
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    _set_stats(worker_id, "sig", 41.2)
    job_id = _make_signed_job(models=("flux1-dev.safetensors",))

    dispatch.assign_jobs([worker_id])

    with db.get_session() as session:
        info = json.loads(session.get(db.Job, job_id).dispatch_info)
        warm = json.loads(session.get(db.Worker, worker_id).warm_models)
    assert info["basis"] == "signature"
    assert info["predicted_seconds"] == pytest.approx(41.2)
    assert info["load_seconds"] == pytest.approx(0.0)
    assert info["fetch_seconds"] == pytest.approx(0.0)
    assert info["candidates"] == 1
    assert warm == ["flux1-dev.safetensors"]


def test_assign_jobs_dispatches_a_starved_job_even_behind_newer_ones(_db):
    """等待超過 STARVE_SECONDS 的 job，只要有合格 worker 一定本 tick 派出。"""
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    now = _utcnow()
    _make_signed_job("j_old", created_at=now - timedelta(seconds=scheduler.STARVE_SECONDS + 60))
    _make_signed_job("j_new", created_at=now)

    assignments = dispatch.assign_jobs([worker_id])

    assert [j.id for _w, j in assignments] == ["j_old"]


def test_assign_jobs_never_dispatches_a_parent_job(_db):
    """split_count > 0 的父 job 從派工清單排除（§2.5 第 2 步）。"""
    worker_id = _make_worker("w1", dynamic={"free_vram_gb": 24})
    job_id = _make_signed_job("j_parent")
    with db.get_session() as session:
        session.get(db.Job, job_id).split_count = 2
        session.commit()

    assert dispatch.assign_jobs([worker_id]) == []
```

`test_dispatch.py` 檔頭的 import 補上 `scheduler`（和既有的 `db, dispatch, metrics` 同一行）以及 `import pytest`（已有）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_dispatch.py -q -k "warm_cache or historically_faster or spreads_two or dispatch_info or starved or parent_job"`
Expected: FAIL（`dispatch_info` 沒被寫、warm/fast 沒有勝出、父 job 被派出去）

- [ ] **Step 3: 改寫 `dispatch.assign_jobs`**

`server/comfyfed_server/dispatch.py:46-208` 目前整個函式（從 `def assign_jobs(` 到 `return assignments`，含那段很長的 docstring 與兩層候選排序迴圈）全部換掉。先把檔頭第 12 行的 import 改成：

```python
from . import assess, db, metrics, scheduler, stats
```

然後把整個 `assign_jobs` 換成：

```python
# §2.5 第 2 步：一個 tick 最多評估這麼多件 queued job（外加所有已餓死的），
# 免得一個塞了幾千件的佇列把 O(n^3) 的配對拖垮。
_MAX_JOBS_PER_TICK = 64
_JOBS_PER_IDLE_WORKER = 8


def _dispatch_info(
    predicted_seconds: float,
    basis: str,
    load_seconds: float,
    fetch_seconds: float,
    candidates: int,
) -> str:
    return json.dumps(
        {
            "predicted_seconds": round(predicted_seconds, 3),
            "basis": basis,
            "load_seconds": round(load_seconds, 3),
            "fetch_seconds": round(fetch_seconds, 3),
            "candidates": candidates,
        }
    )


def assign_jobs(
    idle_worker_ids: list[str],
    fetchable_models: Optional[dict[str, int]] = None,
    peer_only_models: Optional[frozenset[str]] = None,
) -> list[tuple[str, db.Job]]:
    """Phase 3.3 §2.5：一次把整批 queued job 和整批 idle worker 做整體配對。

    取代 Phase 2.1 的逐 job 貪婪排序。流程：

    1. 取 queued job（`created_at ASC`，排除 `split_count > 0` 的父 job），
       最多 `min(64, 8 x idle 數)` 件，另外把等待超過 `STARVE_SECONDS` 的
       一律納入 -- 餓死防護不能被上限吃掉。
    2. 對每對 (job, worker) 算 `assess.verdict`，壓成 `scheduler.PairVerdict`；
       同時用 `stats.predict` 取這對的預估執行秒數與依據。
    3. `scheduler.match` 求最小成本配對（Hungarian，∞ 的配對永不採用）。
    4. 依結果逐一原子 claim（`WHERE status='queued'`，rowcount != 1 就跳過），
       並寫入 `jobs.dispatch_info` 與 `workers.warm_models`。

    保留的既有語意（見 `scheduler.cost`）：乾淨贏過警告（warn penalty 1e6）、
    已經有模型的贏過要下載的（tier 1 存在時 tier 2 一律 ∞）、輕工作留大卡
    （light penalty）。

    決定性：jobs 先依 `(created_at, id)`、workers 先依 `(name, id)` 排序，
    Hungarian 本身在平手時取索引最小者，所以同一組輸入兩棧得到同一個配對。

    `fetchable_models` / `peer_only_models` 一如既往直接傳給 `assess.verdict`；
    `None`（預設）代表「沒有東西可下載」。回傳實際 claim 成功的
    `(worker_id, job)`，供 `agentws.dispatch_tick` 推送。
    """
    if not idle_worker_ids:
        return []

    now = _utcnow()

    with db.get_session() as session:
        # `deleted == False`：admin 刪掉的 worker 永遠不該被派工，即使它的
        # socket 還在拆除中（見 `db.Worker.deleted` / `agentws.kick_worker`）。
        workers = (
            session.query(db.Worker)
            .filter(db.Worker.id.in_(idle_worker_ids), db.Worker.deleted == False)  # noqa: E712
            .all()
        )
        if not workers:
            return []

        all_workers = session.query(db.Worker).filter(db.Worker.deleted == False).all()  # noqa: E712

        # 父 job（split_count > 0）不進配對：它的工作由子 job 執行。
        queued_jobs = (
            session.query(db.Job)
            .filter(db.Job.status == "queued", db.Job.split_count == 0)
            .order_by(db.Job.created_at.asc(), db.Job.id.asc())
            .all()
        )

        limit = min(_MAX_JOBS_PER_TICK, _JOBS_PER_IDLE_WORKER * len(workers))
        starve_cutoff = now - timedelta(seconds=scheduler.STARVE_SECONDS)
        head = queued_jobs[:limit]
        head_ids = {job.id for job in head}
        starved = [
            job
            for job in queued_jobs[limit:]
            if job.created_at is not None and job.created_at <= starve_cutoff
        ]
        selected_jobs = head + [job for job in starved if job.id not in head_ids]

        if not selected_jobs:
            return []

        workers.sort(key=lambda w: (w.name or "", w.id))

        stat_rows = stats.load_rows()
        speed_index = {
            w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
            for w in all_workers
        }

        job_candidates: list[scheduler.JobCandidate] = []
        worker_candidates: list[scheduler.WorkerCandidate] = []
        pairs: dict[tuple[str, str], scheduler.PairVerdict] = {}
        predictions: dict[tuple[str, str], float] = {}
        bases: dict[tuple[str, str], str] = {}

        for worker in workers:
            worker_candidates.append(
                scheduler.WorkerCandidate(
                    worker_id=worker.id,
                    name=worker.name or "",
                    backend=worker.backend or "",
                    free_vram_gb=_free_vram_gb(worker),
                    warm_models=tuple(_json_list(worker.warm_models)),
                    inventory=tuple(assess.model_inventory(worker)),
                )
            )

        for job in selected_jobs:
            try:
                requirements_override = json.loads(job.requirements or "{}")
            except (TypeError, ValueError):
                requirements_override = {}

            needs = assess.needs_from_job(job)
            is_light = not needs.models and not (needs.est_vram_gb or 0)
            job_candidates.append(
                scheduler.JobCandidate(
                    job_id=job.id,
                    signature=job.signature,
                    created_at=job.created_at or now,
                    is_light=is_light,
                    required_models=tuple(sorted(needs.models)),
                )
            )

            for worker in workers:
                v = assess.verdict(
                    worker,
                    needs,
                    requirements_override,
                    all_workers,
                    fetchable_models,
                    peer_only_models,
                )
                total_fetch_bytes = 0
                if v.kind == "eligible_after_fetch":
                    total_fetch_bytes = sum(
                        (fetchable_models or {}).get(name, 0) for name in v.missing_models
                    )
                pairs[(job.id, worker.id)] = scheduler.PairVerdict(
                    kind=v.kind,
                    has_warnings=bool(v.warnings),
                    total_fetch_bytes=total_fetch_bytes,
                )
                seconds, basis = stats.predict(stat_rows, speed_index, job.signature, worker.id)
                predictions[(job.id, worker.id)] = seconds
                bases[(job.id, worker.id)] = basis

        matched = scheduler.match(job_candidates, worker_candidates, pairs, predictions, now)

        assignments: list[tuple[str, db.Job]] = []
        for job_index, worker_index in matched:
            job = selected_jobs[job_index]
            worker = workers[worker_index]
            job_candidate = job_candidates[job_index]
            worker_candidate = worker_candidates[worker_index]
            pair = pairs[(job.id, worker.id)]

            candidate_count = sum(
                1
                for w in workers
                if pairs[(job.id, w.id)].kind in ("eligible", "eligible_after_fetch")
            )
            info = _dispatch_info(
                predictions[(job.id, worker.id)],
                bases[(job.id, worker.id)],
                scheduler.load_seconds(job_candidate, worker_candidate),
                scheduler.fetch_seconds(pair),
                candidate_count,
            )

            # 原子 claim：只有在 job 仍然 queued 的時候才成立。別的行程／執行緒
            # 搶先一步就 rowcount == 0，跳過而不是重複指派。
            result = session.execute(
                update(db.Job)
                .where(db.Job.id == job.id, db.Job.status == "queued")
                .values(status="assigned", worker_id=worker.id, dispatch_info=info)
            )
            if result.rowcount != 1:
                session.rollback()
                continue

            # §2.2：熱快取在「被指派」當下就成立（載入發生在開始執行時），
            # 所以這裡就寫，不等 job 完成。
            worker_row = session.get(db.Worker, worker.id)
            if worker_row is not None:
                worker_row.warm_models = json.dumps(list(job_candidate.required_models))

            session.commit()
            session.refresh(job)
            assignments.append((worker.id, job))

        return assignments
```

同時在 `dispatch.py` 的 `_free_vram_gb`（第 34-43 行）之後加一個小 helper：

```python
def _json_list(raw) -> list:
    """JSON 陣列欄位的防禦式解析；壞掉就當空陣列，不要讓一個 tick 因為一列
    壞資料整個炸掉。"""
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []
```

`dispatch.py` 檔頭第 7 行的 `from datetime import datetime, timedelta, timezone` 已經有 `timedelta`，不用改。

- [ ] **Step 4: 跑 Python 派工測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_dispatch.py -q`
Expected: PASS（含既有測試）。既有測試預期不變的理由：清乾淨贏過警告靠 `WARN_PENALTY`，tier1 贏過 tier2 靠 `cost` 的 `tier1_exists` 分支，輕工作偏好靠 `light_penalty`，重工作偏大卡靠 `_legacy_tiebreak`，fetch tier 偏小下載量靠 `fetch_seconds`。若有任何一個掛掉，**先確認是演算法真的改變了語意**，再更新期望值；不要為了讓測試綠而放寬這些語意。

- [ ] **Step 5: job_done 回饋統計（Python）**

`server/comfyfed_server/agentws.py:670-707` 的 `_handle_job_done` 尾端目前是：

```python
    if done:
        _clear_fetch_progress(job_id)
        await _notify_panel_job_done(job_id)
        exec_seconds = message.get("exec_seconds")
        if not _is_valid_exec_seconds(exec_seconds):
            exec_seconds = None
        await _create_and_push_receipt(worker_id, conn, job_id, exec_seconds)
```

改成：

```python
    if done:
        _clear_fetch_progress(job_id)
        await _notify_panel_job_done(job_id)
        exec_seconds = message.get("exec_seconds")
        if not _is_valid_exec_seconds(exec_seconds):
            exec_seconds = None
        # Phase 3.3 §2.3：只有真的完成、且 exec_seconds 有效才進統計。
        # 放在收據之前，因為它自己吞例外 -- 統計壞掉絕不能少發一張收據。
        _record_job_stats(worker_id, job_id, exec_seconds)
        await _create_and_push_receipt(worker_id, conn, job_id, exec_seconds)
```

在 `_create_and_push_receipt`（第 1185 行）之前插入：

```python
def _record_job_stats(
    worker_id: str, job_id: Optional[str], exec_seconds: Optional[float]
) -> None:
    """Phase 3.3 §2.3：把這次完成的執行秒數餵給 `stats.record_completion`。

    只讀一次 job 拿 `signature`（`record_completion` 自己不認得 job）。整段
    包在 try 裡，且 `record_completion` 內部也吞例外 -- 統計是附帶效果，
    job_done 的主流程（面板事件、收據）絕不能因為它失敗。
    """
    if not job_id or not stats.is_valid_exec_seconds(exec_seconds):
        return
    try:
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            signature = job.signature if job is not None else None
    except Exception:
        logger.exception("agentws: failed to read signature for job %s", job_id)
        return
    stats.record_completion(worker_id, signature, exec_seconds)
```

並把 `stats` 加進 `agentws.py` 檔頭的 `from . import ...` 清單。

在 `tests/server/test_agent_ws.py` 加一個測試（放在既有 job_done/收據那一段旁邊，沿用該檔既有的 fake-agent fixture）：

```python
@pytest.mark.anyio
async def test_job_done_records_worker_job_stats(_db, _agent):
    """job_done 帶有效 exec_seconds 時，worker_job_stats 要長出一列。"""
    job_id = _queue_job_for(_agent.worker_id, signature="sig-abc")
    await _agent.send({"type": "job_done", "job_id": job_id, "result_files": [], "exec_seconds": 42.0})
    await _agent.drain()

    with db.get_session() as session:
        row = session.get(db.WorkerJobStats, (_agent.worker_id, "sig-abc"))
    assert row is not None
    assert row.ewma_seconds == pytest.approx(42.0)
    assert row.samples == 1


@pytest.mark.anyio
async def test_job_failed_does_not_record_stats(_db, _agent):
    job_id = _queue_job_for(_agent.worker_id, signature="sig-abc")
    await _agent.send({"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 42.0})
    await _agent.drain()

    with db.get_session() as session:
        assert session.query(db.WorkerJobStats).count() == 0
```

> `_agent` / `_queue_job_for` / `_agent.drain()` 是示意名稱。實作時先看
> `tests/server/test_agent_ws.py` 既有的 fixture 與 helper（該檔已經有一整套
> 連線＋指派 job 的樣板），**沿用它們**，只把 `signature=` 這個欄位補進建立
> job 的那個 helper（若它沒有這個參數就加上，預設 `None`）。

- [ ] **Step 6: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 7: cloud queries 支援 dispatch_info / warm_models / 父 job 排除**

`cloud/src/db/queries.ts:713-736` 目前是：

```ts
export async function getQueuedJobsOrderedByCreatedAt(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC")
    .all<JobRow>();
  return results.map(rowToJob);
}

/** Atomic claim: ... */
export async function claimJob(db: D1Database, jobId: string, workerId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ? AND status = 'queued'")
    .bind(workerId, jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
```

改成（保留 `getQueuedJobsOrderedByCreatedAt` 給既有呼叫端，新增一個排除父 job 的派工專用查詢；`claimJob` 多一個可選參數）：

```ts
export async function getQueuedJobsOrderedByCreatedAt(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC")
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 派工專用的 queued 清單：排除 `split_count > 0` 的父 job -- 它的工作由子
 * job 執行，父 job 本身永遠不該被指派給 worker（Phase 3.3 §2.5 第 2 步）。 */
export async function getQueuedJobsForDispatch(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' AND split_count = 0 ORDER BY created_at ASC, id ASC")
    .all<JobRow>();
  return results.map(rowToJob);
}

/** Atomic claim: only flips `queued` -> `assigned` (and sets `worker_id`, plus
 * Phase 3.3's `dispatch_info` when given) if the job is still queued at the
 * moment the UPDATE runs. Returns whether the claim succeeded. */
export async function claimJob(
  db: D1Database,
  jobId: string,
  workerId: string,
  dispatchInfo?: string
): Promise<boolean> {
  const result =
    dispatchInfo === undefined
      ? await db
          .prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ? AND status = 'queued'")
          .bind(workerId, jobId)
          .run()
      : await db
          .prepare(
            "UPDATE jobs SET status = 'assigned', worker_id = ?, dispatch_info = ? WHERE id = ? AND status = 'queued'"
          )
          .bind(workerId, dispatchInfo, jobId)
          .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Phase 3.3 §2.2: 記住這台 worker 最近一次被指派的 job 的 required_models，
 * 供下一輪的熱快取親和使用。claim 成功當下就寫，不等 job 完成。 */
export async function setWorkerWarmModels(db: D1Database, workerId: string, models: string[]): Promise<void> {
  await db.prepare("UPDATE workers SET warm_models = ? WHERE id = ?").bind(JSON.stringify(models), workerId).run();
}
```

- [ ] **Step 8: 改寫 `assignJobs`**

`cloud/src/core/dispatch.ts:81-169` 整個 `assignJobs`（從 `export async function assignJobs(` 到它的 `return assignments;`）換掉，並把第 15-18 行的 import 改成：

```ts
import * as queries from "../db/queries";
import type { Job } from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { modelInventory, needsFromJob, verdict, type FetchableModels } from "./assess";
import * as scheduler from "./scheduler";
import * as stats from "./stats";
```

> 第 18 行原本 import 的 `freeVramGb` 改由 `scheduler` 的成本模型吸收，但
> `WorkerCandidate.freeVramGb` 還是要靠它算，所以保留 `freeVramGb` 也一起
> import；`modelInventory` 若 `core/assess.ts` 沒有這個 export，就直接用
> `worker.modelInventory`（`rowToWorker` 已經解析好了），並把它從 import 拿掉。

新的 `assignJobs`：

```ts
/** 一個 tick 最多評估這麼多件 queued job（外加所有已餓死的）。 */
const MAX_JOBS_PER_TICK = 64;
const JOBS_PER_IDLE_WORKER = 8;

function dispatchInfoJson(
  predictedSeconds: number,
  basis: string,
  loadSeconds: number,
  fetchSeconds: number,
  candidates: number
): string {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  return JSON.stringify({
    predicted_seconds: round3(predictedSeconds),
    basis,
    load_seconds: round3(loadSeconds),
    fetch_seconds: round3(fetchSeconds),
    candidates,
  });
}

/**
 * Phase 3.3 §2.5：整體配對。Ports `dispatch.assign_jobs` -- 見該 docstring 的
 * 完整理由。流程：取 queued job（排除 `split_count > 0` 的父 job，最多
 * `min(64, 8 x idle)` 件外加所有餓死的）-> 每對算 verdict + `stats.predict`
 * -> `scheduler.match` -> 逐一原子 claim 並寫 `dispatch_info` /
 * `warm_models`。
 *
 * 決定性：jobs 依 `(created_at, id)`（SQL 已排好）、workers 依 `(name, id)`
 * 排序後才進矩陣，Hungarian 平手取最小索引，所以和 Python 端同一組輸入得到
 * 同一個配對。
 */
export async function assignJobs(
  db: D1Database,
  idleWorkerIds: string[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null,
  now: Date = new Date()
): Promise<Assignment[]> {
  if (idleWorkerIds.length === 0) return [];

  const idleWorkers = (await queries.getWorkersByIds(db, idleWorkerIds)).filter((w) => !w.deleted);
  if (idleWorkers.length === 0) return [];
  idleWorkers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const allWorkers = await queries.getAllWorkers(db);
  const queuedJobs = await queries.getQueuedJobsForDispatch(db);

  const limit = Math.min(MAX_JOBS_PER_TICK, JOBS_PER_IDLE_WORKER * idleWorkers.length);
  const starveCutoffMs = now.getTime() - scheduler.STARVE_SECONDS * 1000;
  const head = queuedJobs.slice(0, limit);
  const headIds = new Set(head.map((j) => j.id));
  const starved = queuedJobs
    .slice(limit)
    .filter((j) => new Date(`${j.createdAt}Z`).getTime() <= starveCutoffMs && !headIds.has(j.id));
  const selectedJobs = [...head, ...starved];
  if (selectedJobs.length === 0) return [];

  const statRows = await stats.loadRows(db);
  const speedIndex = new Map(allWorkers.map((w) => [w.id, w.speedIndex] as const));

  const workerCandidates: scheduler.WorkerCandidate[] = idleWorkers.map((w) => ({
    workerId: w.id,
    name: w.name,
    backend: w.backend,
    freeVramGb: freeVramGb(w),
    warmModels: w.warmModels,
    inventory: w.modelInventory,
  }));

  const jobCandidates: scheduler.JobCandidate[] = [];
  const pairs = new Map<string, scheduler.PairVerdict>();
  const predictions = new Map<string, number>();
  const bases = new Map<string, string>();

  for (const job of selectedJobs) {
    const needs = needsFromJob(job);
    const isLight = needs.models.size === 0 && !needs.estVramGb;
    jobCandidates.push({
      jobId: job.id,
      signature: job.signature,
      createdAt: new Date(`${job.createdAt}Z`),
      isLight,
      requiredModels: [...needs.models].sort(),
    });

    for (const worker of idleWorkers) {
      const v = verdict(worker, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels);
      const totalFetchBytes =
        v.kind === "eligible_after_fetch"
          ? v.missingModels.reduce((sum, name) => sum + (fetchableModels?.[name] ?? 0), 0)
          : 0;
      const key = scheduler.pairKey(job.id, worker.id);
      pairs.set(key, { kind: v.kind, hasWarnings: v.warnings.length > 0, totalFetchBytes });
      const { seconds, basis } = stats.predict(statRows, speedIndex, job.signature, worker.id);
      predictions.set(key, seconds);
      bases.set(key, basis);
    }
  }

  const matched = scheduler.match(jobCandidates, workerCandidates, pairs, predictions, now);

  const assignments: Assignment[] = [];
  for (const [jobIndex, workerIndex] of matched) {
    const job = selectedJobs[jobIndex]!;
    const worker = idleWorkers[workerIndex]!;
    const jobCandidate = jobCandidates[jobIndex]!;
    const workerCandidate = workerCandidates[workerIndex]!;
    const key = scheduler.pairKey(job.id, worker.id);
    const pair = pairs.get(key)!;

    const candidateCount = idleWorkers.filter((w) => {
      const kind = pairs.get(scheduler.pairKey(job.id, w.id))!.kind;
      return kind === "eligible" || kind === "eligible_after_fetch";
    }).length;

    const info = dispatchInfoJson(
      predictions.get(key)!,
      bases.get(key)!,
      scheduler.loadSeconds(jobCandidate, workerCandidate),
      scheduler.fetchSeconds(pair),
      candidateCount
    );

    const claimed = await queries.claimJob(db, job.id, worker.id, info);
    if (!claimed) continue;

    // §2.2：熱快取在「被指派」當下就成立，不等 job 完成。
    await queries.setWorkerWarmModels(db, worker.id, jobCandidate.requiredModels);

    const updatedJob = await queries.getJobById(db, job.id);
    if (!updatedJob) continue; // defensive: cannot happen once claimed
    assignments.push({ workerId: worker.id, job: updatedJob });
  }

  return assignments;
}
```

> `toSqliteTimestamp` 在新版 `assignJobs` 裡沒用到，但 `requeueStale` 還在用，
> 所以 import 保留。`freeVramGb` 從 `./assess` import（原本就有）。

- [ ] **Step 9: hub.ts 掛回填與 job_done 統計**

`cloud/src/do/hub.ts` 的 `tick()`（第 1544 行起）開頭目前是：

```ts
  private async tick(): Promise<void> {
    const db = this.env.DB;
    const now = new Date();

    let requeued: string[] = [];
```

改成：

```ts
  private async tick(): Promise<void> {
    const db = this.env.DB;
    const now = new Date();

    // Phase 3.3 §2.6：第一次 tick 時把 worker_job_stats 從最近 500 筆完成
    // 收據補起來（`stats_backfilled` 旗標，跨 DO 重啟只會做一次）。
    // `statsBackfillDone` 是 per-instance 的短路，避免每個 tick 都去讀旗標。
    if (!this.statsBackfillDone) {
      this.statsBackfillDone = true;
      try {
        await stats.backfillIfNeeded(db);
      } catch (err) {
        console.error("hub: stats backfill failed", err);
      }
    }

    let requeued: string[] = [];
```

在 Hub class 的欄位宣告區（和 `fetchProgress` 同一處）加入：

```ts
  /** Phase 3.3 §2.6: 這個 DO instance 是否已經嘗試過統計回填。旗標本身存在
   * D1（`stats.BACKFILL_SETTING_KEY`），這只是省掉每個 tick 一次讀取。 */
  private statsBackfillDone = false;
```

同一檔的 `tick()` 裡把 `hasQueuedWork` 那一行的 `getQueuedJobsOrderedByCreatedAt` 換成 `getQueuedJobsForDispatch`（父 job 不算「有待派的工作」），並把 `assignJobs` 呼叫補上 `now`：

```ts
    const hasQueuedWork = idleWorkerIds.length > 0 && (await queries.getQueuedJobsForDispatch(db)).length > 0;
```

```ts
      assignments = await dispatch.assignJobs(db, idleWorkerIds, fetchableModels, peerOnlyModels, now);
```

`handleJobDone`（第 1195-1213 行）尾端目前是：

```ts
    if (done) {
      this.fetchProgress.delete(jobId!);
      // Separate lookup rather than reusing the row `updateJobDone` already
      // touched -- mirrors agentws.py's `_notify_panel_job_done`: `jobOutputs`
      // needs `resultFiles`/`workflowJson` off the freshly-committed row.
      const freshJob = await queries.getJobById(db, jobId!);
      if (freshJob) await this.panelJobDone(freshJob);

      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      await this.createAndPushReceipt(ws, attachment, jobId!, execSeconds, now);
    }
```

改成：

```ts
    if (done) {
      this.fetchProgress.delete(jobId!);
      // Separate lookup rather than reusing the row `updateJobDone` already
      // touched -- mirrors agentws.py's `_notify_panel_job_done`: `jobOutputs`
      // needs `resultFiles`/`workflowJson` off the freshly-committed row.
      const freshJob = await queries.getJobById(db, jobId!);
      if (freshJob) await this.panelJobDone(freshJob);

      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      // Phase 3.3 §2.3：只有真的完成、且 exec_seconds 有效才進統計。放在收據
      // 之前，因為 recordCompletion 自己吞例外 -- 統計壞掉絕不能少發一張收據。
      await stats.recordCompletion(db, workerId, freshJob?.signature ?? null, execSeconds, now);
      await this.createAndPushReceipt(ws, attachment, jobId!, execSeconds, now);
    }
```

在 `hub.ts` 檔頭補上 `import * as stats from "../core/stats";`。

- [ ] **Step 10: 寫 cloud 派工語意測試**

在 `cloud/test/dispatch.spec.ts` 檔尾加入（沿用該檔既有的 `db()` / `makeWorker()` / `uniqueId()` / `afterEach` 清表）：

```ts
describe("Phase 3.3 scheduler semantics", () => {
  async function makeSignedJob(
    id: string,
    opts: { signature?: string | null; models?: string[]; estVramGb?: number | null; createdAt?: Date; splitCount?: number } = {}
  ): Promise<string> {
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_models, est_vram_gb, split_count)
         VALUES (?, '{}', 'queued', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        toSqliteTimestamp(opts.createdAt ?? new Date()),
        opts.signature ?? "sig",
        JSON.stringify(opts.models ?? []),
        opts.estVramGb ?? null,
        opts.splitCount ?? 0
      )
      .run();
    return id;
  }

  async function setStats(workerId: string, signature: string, ewma: number): Promise<void> {
    await db()
      .prepare("INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES (?, ?, ?, 3, ?)")
      .bind(workerId, signature, ewma, toSqliteTimestamp(new Date()))
      .run();
  }

  it("prefers a warm cache over a bigger but cold card", async () => {
    const inventory = [{ name: "diffusion_models/flux1-dev.safetensors", size: 22 }];
    const warm = await makeWorker("w_warm", { dynamic: { free_vram_gb: 16 }, modelInventory: inventory });
    const cold = await makeWorker("w_cold", { dynamic: { free_vram_gb: 48 }, modelInventory: inventory });
    await db().prepare("UPDATE workers SET warm_models = ? WHERE id = ?").bind(JSON.stringify(["flux1-dev.safetensors"]), warm).run();
    const jobId = await makeSignedJob(uniqueId("j"), { models: ["flux1-dev.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [warm, cold]);
    expect(assignments.map((a) => [a.workerId, a.job.id])).toEqual([[warm, jobId]]);
  });

  it("prefers the historically faster worker", async () => {
    const slow = await makeWorker("w_slow", { dynamic: { free_vram_gb: 24 } });
    const fast = await makeWorker("w_fast", { dynamic: { free_vram_gb: 24 } });
    await setStats(slow, "sig", 90);
    await setStats(fast, "sig", 30);
    const jobId = await makeSignedJob(uniqueId("j"));

    const assignments = await dispatch.assignJobs(db(), [slow, fast]);
    expect(assignments.map((a) => [a.workerId, a.job.id])).toEqual([[fast, jobId]]);
  });

  it("spreads two heavy jobs across two cards", async () => {
    const big = await makeWorker("w_big", { dynamic: { free_vram_gb: 48 } });
    const small = await makeWorker("w_small", { dynamic: { free_vram_gb: 24 } });
    const now = new Date();
    const j1 = await makeSignedJob(uniqueId("j"), { estVramGb: 10, createdAt: new Date(now.getTime() - 10_000) });
    const j2 = await makeSignedJob(uniqueId("j"), { estVramGb: 10, createdAt: now });

    const assignments = await dispatch.assignJobs(db(), [big, small]);
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((a) => a.workerId))).toEqual(new Set([big, small]));
    expect(new Set(assignments.map((a) => a.job.id))).toEqual(new Set([j1, j2]));
  });

  it("writes dispatch_info and warm_models on claim", async () => {
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    await setStats(workerId, "sig", 41.2);
    const jobId = await makeSignedJob(uniqueId("j"), { models: ["flux1-dev.safetensors"] });

    await dispatch.assignJobs(db(), [workerId]);

    const jobRow = await db().prepare("SELECT dispatch_info FROM jobs WHERE id = ?").bind(jobId).first<{ dispatch_info: string }>();
    const info = JSON.parse(jobRow!.dispatch_info);
    expect(info.basis).toBe("signature");
    expect(info.predicted_seconds).toBeCloseTo(41.2, 6);
    expect(info.load_seconds).toBeCloseTo(0, 6);
    expect(info.fetch_seconds).toBeCloseTo(0, 6);
    expect(info.candidates).toBe(1);

    const workerRow = await db().prepare("SELECT warm_models FROM workers WHERE id = ?").bind(workerId).first<{ warm_models: string }>();
    expect(JSON.parse(workerRow!.warm_models)).toEqual(["flux1-dev.safetensors"]);
  });

  it("dispatches a starved job ahead of newer ones", async () => {
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    const now = new Date();
    const old = await makeSignedJob(uniqueId("j_old"), { createdAt: new Date(now.getTime() - (scheduler.STARVE_SECONDS + 60) * 1000) });
    await makeSignedJob(uniqueId("j_new"), { createdAt: now });

    const assignments = await dispatch.assignJobs(db(), [workerId], null, null, now);
    expect(assignments.map((a) => a.job.id)).toEqual([old]);
  });

  it("never dispatches a parent job", async () => {
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    await makeSignedJob(uniqueId("j_parent"), { splitCount: 2 });

    expect(await dispatch.assignJobs(db(), [workerId])).toEqual([]);
  });
});
```

檔頭補上 `import * as scheduler from "../src/core/scheduler";`，並在 `afterEach` 的清表清單加入 `await db().prepare("DELETE FROM worker_job_stats").run();`。

- [ ] **Step 11: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠。`dispatch.spec.ts` 既有測試的期望理由和 Python 端相同（見 Step 4），不該需要放寬。

- [ ] **Step 12: Commit**

```bash
git add server/comfyfed_server/dispatch.py server/comfyfed_server/agentws.py tests/server/test_dispatch.py tests/server/test_agent_ws.py cloud/src/core/dispatch.ts cloud/src/db/queries.ts cloud/src/do/hub.ts cloud/test/dispatch.spec.ts
git commit -F - <<'MSGEOF'
feat(scheduler): dispatch through the Hungarian matcher on both stacks

Phase 3.3 Task 4. assign_jobs / assignJobs now build a (job x worker) cost
matrix from assess.verdict plus stats.predict and solve it globally instead of
ranking greedily per job, writing dispatch_info and warm_models on claim and
excluding split parents from the queue. job_done feeds exec_seconds back into
stats.record_completion, and the cloud runs the §2.6 backfill on its first tick.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 5: 拆分判定與子 workflow 重寫（兩棧純函數）

**Files:**
- Create: `server/comfyfed_server/split.py`（本任務只放純函數；`refresh_parent` / `parent_outputs` 在 Task 6 補進同一個檔）
- Create: `cloud/src/core/split.ts`（同上）
- Test: `tests/server/test_split.py`（新檔）、`cloud/test/split.spec.ts`（新檔）

**Interfaces:**
- Consumes: 無（純資料進出，不碰 DB、不碰 assess）。
- Produces（Task 6/7/10 依賴）：
  - Python：`split.SplitPlan(source_node_id: str, batch_size: int)`（frozen dataclass）；`split.MAX_SPLIT = 8`；`split.SPLIT_SAFE_CLASSES: frozenset[str]`；`split.BATCH_SOURCE_CLASSES: tuple[str, ...]`；`split.split_plan(workflow: dict, requirements: dict | None = None, split_batches: bool = True) -> SplitPlan | None`；`split.child_workflow(workflow: dict, plan: SplitPlan, start: int, length: int) -> dict | None`；`split.partition(batch_size: int, k: int) -> list[tuple[int, int]]`。
  - TS：`export interface SplitPlan { sourceNodeId: string; batchSize: number }`；`export const MAX_SPLIT = 8`；`export const SPLIT_SAFE_CLASSES: ReadonlySet<string>`；`splitPlan(workflow: Record<string, unknown>, requirements?: Record<string, unknown> | null, splitBatches?: boolean): SplitPlan | null`；`childWorkflow(workflow, plan: SplitPlan, start: number, length: number): Record<string, unknown> | null`；`partition(batchSize: number, k: number): [number, number][]`。

**設計註記：** spec §3.2 條件 5（`requirements.split !== false` 且平台設定 `split_batches` 為真）也做進 `split_plan`，用兩個帶預設值的參數帶進來，這樣「每一個否決條件」都在同一個純函數裡、同一組單元測試涵蓋得到；呼叫端（Task 6）只負責把設定讀出來傳進去。

- [ ] **Step 1: 寫失敗的 Python 測試**

Create `tests/server/test_split.py`：

```python
"""Unit tests for split.py -- Phase 3.3 §3.2 的每一個否決條件、§3.3 的子
workflow 重寫與分片。全部是純函數，不需要 DB。
"""

import copy

import pytest

from comfyfed_server import split


def _batch_workflow(batch_size=4, extra=None):
    """一張最小但完整可拆的圖：loader -> 條件 -> EmptyLatentImage -> KSampler
    -> VAEDecode -> SaveImage。"""
    workflow = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "wuxia", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 512, "height": 512, "batch_size": batch_size},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
                "steps": 20,
                "seed": 424242,
            },
        },
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0]}},
    }
    if extra:
        workflow.update(copy.deepcopy(extra))
    return workflow


# --- §3.2 可拆判定 ---------------------------------------------------------


def test_split_plan_accepts_a_clean_batch_workflow():
    plan = split.split_plan(_batch_workflow(batch_size=4))
    assert plan == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_vetoes_batch_size_one():
    assert split.split_plan(_batch_workflow(batch_size=1)) is None


def test_split_plan_vetoes_a_non_literal_batch_size():
    workflow = _batch_workflow()
    workflow["4"]["inputs"]["batch_size"] = ["9", 0]
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_two_batch_sources():
    workflow = _batch_workflow()
    workflow["8"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 512, "height": 512, "batch_size": 2},
    }
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_any_other_node_carrying_batch_size():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "KSampler", "inputs": {"batch_size": 1, "latent_image": ["4", 0]}}
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_a_node_outside_the_whitelist():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "SomeCustomNode", "inputs": {}}
    assert split.split_plan(workflow) is None


@pytest.mark.parametrize("class_type", ["ImageBatch", "LatentBatch", "RepeatLatentBatch", "RebatchLatents"])
def test_split_plan_vetoes_the_explicitly_named_batch_nodes(class_type):
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": class_type, "inputs": {}}
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_a_sampler_whose_latent_does_not_come_from_the_batch_source():
    workflow = _batch_workflow()
    # 另一條 latent 來源：VAEEncode 從影像編碼出來的 latent，追不到批次來源。
    workflow["8"] = {"class_type": "LoadImage", "inputs": {"image": "x.png"}}
    workflow["9"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}}
    workflow["5"]["inputs"]["latent_image"] = ["9", 0]
    assert split.split_plan(workflow) is None


def test_split_plan_allows_a_latent_passthrough_chain_to_the_batch_source():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "LatentUpscale", "inputs": {"samples": ["4", 0]}}
    workflow["5"]["inputs"]["latent_image"] = ["8", 0]
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_allows_a_refiner_chain_of_two_samplers():
    workflow = _batch_workflow()
    workflow["8"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {"model": ["1", 0], "latent_image": ["5", 0], "steps": 10},
    }
    workflow["6"]["inputs"]["samples"] = ["8", 0]
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_ignores_ksampler_select_which_has_no_latent_input():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_vetoes_when_requirements_say_no():
    assert split.split_plan(_batch_workflow(), requirements={"split": False}) is None
    assert split.split_plan(_batch_workflow(), requirements={"split": True}) is not None
    assert split.split_plan(_batch_workflow(), requirements={}) is not None


def test_split_plan_vetoes_when_the_platform_setting_is_off():
    assert split.split_plan(_batch_workflow(), split_batches=False) is None


def test_split_plan_handles_a_junk_workflow_without_raising():
    assert split.split_plan({}) is None
    assert split.split_plan({"1": "not a dict"}) is None
    assert split.split_plan({"1": {"class_type": 7, "inputs": {}}}) is None


# --- §3.3 子 workflow 重寫 -------------------------------------------------


def test_child_workflow_inserts_latent_from_batch_and_rewires_consumers():
    workflow = _batch_workflow(batch_size=4)
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=2, length=2)

    assert child["cfsplit"] == {
        "class_type": "LatentFromBatch",
        "inputs": {"samples": ["4", 0], "batch_index": 2, "length": 2},
    }
    assert child["5"]["inputs"]["latent_image"] == ["cfsplit", 0]
    # 來源節點本身的 batch_size 不改：LatentFromBatch 需要整批 shape 才能算對片。
    assert child["4"]["inputs"]["batch_size"] == 4
    # 原圖不被就地修改。
    assert workflow["5"]["inputs"]["latent_image"] == ["4", 0]


def test_child_workflow_picks_a_free_node_id_when_cfsplit_is_taken():
    workflow = _batch_workflow()
    workflow["cfsplit"] = {"class_type": "PreviewImage", "inputs": {"images": ["6", 0]}}
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=0, length=2)

    assert child["cfsplit"]["class_type"] == "PreviewImage"
    assert child["cfsplit_1"]["class_type"] == "LatentFromBatch"
    assert child["5"]["inputs"]["latent_image"] == ["cfsplit_1", 0]


def test_child_workflow_rewires_every_consumer_of_the_source():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "LatentUpscale", "inputs": {"samples": ["4", 0]}}
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=1, length=1)

    assert child["5"]["inputs"]["latent_image"] == ["cfsplit", 0]
    assert child["8"]["inputs"]["samples"] == ["cfsplit", 0]


def test_child_workflow_returns_none_when_nothing_references_the_source():
    """理論上被 §3.2 條件 4 擋掉；真的發生就不拆（spec §5）。"""
    workflow = _batch_workflow()
    plan = split.SplitPlan(source_node_id="no-such-node", batch_size=4)
    assert split.child_workflow(workflow, plan, start=0, length=2) is None


# --- §3.3 分片 -------------------------------------------------------------


def test_partition_splits_evenly_when_it_divides():
    assert split.partition(4, 2) == [(0, 2), (2, 2)]
    assert split.partition(8, 4) == [(0, 2), (2, 2), (4, 2), (6, 2)]


def test_partition_gives_the_remainder_to_the_first_children():
    assert split.partition(5, 2) == [(0, 3), (3, 2)]
    assert split.partition(7, 3) == [(0, 3), (3, 2), (5, 2)]


def test_partition_covers_the_whole_batch_exactly_once():
    for batch_size in range(2, 20):
        for k in range(2, min(batch_size, split.MAX_SPLIT) + 1):
            ranges = split.partition(batch_size, k)
            assert len(ranges) == k
            assert ranges[0][0] == 0
            covered = []
            for start, length in ranges:
                assert length >= 1
                covered.extend(range(start, start + length))
            assert covered == list(range(batch_size))


def test_partition_with_k_one_is_the_whole_batch():
    assert split.partition(4, 1) == [(0, 4)]


def test_partition_clamps_k_to_the_batch_size():
    assert split.partition(2, 5) == [(0, 1), (1, 1)]
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_split.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'comfyfed_server.split'`

- [ ] **Step 3: 實作 `server/comfyfed_server/split.py`**

```python
"""Phase 3.3 §3: 批次拆分。

本檔上半是純函數（可拆判定、子 workflow 重寫、分片），兩棧逐行對照
`cloud/src/core/split.ts`；下半（Task 6 補上）是父 job 狀態推導與輸出組裝，
那部分要碰 DB。

一致性依據見 spec §3.1：ComfyUI 的 `LatentFromBatch` 會把批次 latent 的
`batch_index` 設起來，`prepare_noise` 因此逐片產生雜訊並只保留指定片，所以
拆出來的第 i 張和整批跑的第 i 張是「同 seed 同構圖」。不是逐位元相同
（batch=2 與 batch=1 的 kernel 路徑浮點差異），差異等同於同一個 job 落在
不同 GPU 上本來就有的差異。
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

MAX_SPLIT = 8

# §3.2 條件 1：批次來源節點。
BATCH_SOURCE_CLASSES = ("EmptyLatentImage", "EmptySD3LatentImage")

# §3.2 條件 3：白名單，逐字取自 spec。名單外的任何節點（含所有自訂節點、
# ImageBatch / LatentBatch / RepeatLatentBatch / RebatchLatents、影片節點）
# 一律不可拆 -- 這是 allowlist，不是 denylist，新節點預設不可拆。
SPLIT_SAFE_CLASSES = frozenset(
    {
        # 載入
        "CheckpointLoaderSimple",
        "UNETLoader",
        "DualCLIPLoader",
        "TripleCLIPLoader",
        "CLIPLoader",
        "VAELoader",
        "LoraLoader",
        "LoraLoaderModelOnly",
        "ControlNetLoader",
        "UpscaleModelLoader",
        "CLIPVisionLoader",
        "StyleModelLoader",
        "CLIPSetLastLayer",
        # 條件
        "CLIPTextEncode",
        "CLIPTextEncodeSDXL",
        "CLIPTextEncodeFlux",
        "ConditioningCombine",
        "ConditioningConcat",
        "ConditioningSetArea",
        "ConditioningSetAreaPercentage",
        "ConditioningZeroOut",
        "ConditioningSetTimestepRange",
        "FluxGuidance",
        "ControlNetApply",
        "ControlNetApplyAdvanced",
        # 模型調整
        "ModelSamplingFlux",
        "ModelSamplingSD3",
        "ModelSamplingDiscrete",
        # 取樣
        "KSampler",
        "KSamplerAdvanced",
        "SamplerCustom",
        "SamplerCustomAdvanced",
        "RandomNoise",
        "KSamplerSelect",
        "BasicScheduler",
        "BasicGuider",
        "CFGGuider",
        "DisableNoise",
        # Latent / 影像
        "EmptyLatentImage",
        "EmptySD3LatentImage",
        "VAEDecode",
        "VAEDecodeTiled",
        "VAEEncode",
        "VAEEncodeForInpaint",
        "SetLatentNoiseMask",
        "LatentUpscale",
        "LatentUpscaleBy",
        "ImageScale",
        "ImageScaleBy",
        "ImageUpscaleWithModel",
        "ImageInvert",
        "ImageCrop",
        "ImagePadForOutpaint",
        "LoadImage",
        "LoadImageMask",
        "SaveImage",
        "PreviewImage",
    }
)

# §3.2 條件 4：沿 LATENT 邊往上追時，允許「原封不動傳遞 latent 批次結構」的
# 中繼節點。VAEEncode 之類「從別的型別造出 latent」的節點刻意不在這裡 --
# 追到它就代表這條 latent 不是來自批次來源，判定為不可拆。
_LATENT_PASSTHROUGH_CLASSES = frozenset(
    {
        "LatentUpscale",
        "LatentUpscaleBy",
        "SetLatentNoiseMask",
        # 取樣器本身也算：refiner 鏈（KSampler -> KSamplerAdvanced）的第二段
        # 吃的是第一段的輸出 latent，批次結構原樣傳下去。
        "KSampler",
        "KSamplerAdvanced",
        "SamplerCustom",
        "SamplerCustomAdvanced",
    }
)

# 取樣器吃 latent 的輸入欄位名。ComfyUI 核心在這兩個名字之間並不統一
# （KSampler 是 latent_image，LatentUpscale/VAEDecode 是 samples）。
_LATENT_INPUT_FIELDS = ("latent_image", "samples")

_SPLIT_NODE_ID = "cfsplit"


@dataclass(frozen=True)
class SplitPlan:
    source_node_id: str
    batch_size: int


def _nodes(workflow) -> list[tuple[str, str, dict]]:
    """`(node_id, class_type, inputs)`，跳過任何形狀不對的節點。"""
    result = []
    for node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            continue
        inputs = node.get("inputs")
        result.append((str(node_id), class_type, inputs if isinstance(inputs, dict) else {}))
    return result


def _literal_int(inputs: dict, field: str) -> Optional[int]:
    value = inputs.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _link_target(value) -> Optional[str]:
    """ComfyUI API 格式的接線是 `[node_id, slot]`；回傳來源 node_id 字串。"""
    if isinstance(value, list) and len(value) >= 1 and isinstance(value[0], (str, int)):
        return str(value[0])
    return None


def _reaches_batch_source(
    node_id: Optional[str], source_node_id: str, by_id: dict[str, tuple[str, dict]], seen: set
) -> bool:
    """沿 LATENT 邊往上追，看看這條 latent 最終是不是那個批次來源。"""
    if node_id is None or node_id in seen:
        return False
    seen.add(node_id)
    if node_id == source_node_id:
        return True
    entry = by_id.get(node_id)
    if entry is None:
        return False
    class_type, inputs = entry
    if class_type not in _LATENT_PASSTHROUGH_CLASSES:
        return False
    for field in _LATENT_INPUT_FIELDS:
        if field in inputs:
            return _reaches_batch_source(_link_target(inputs[field]), source_node_id, by_id, seen)
    return False


def split_plan(
    workflow: dict,
    requirements: Optional[dict] = None,
    split_batches: bool = True,
) -> Optional[SplitPlan]:
    """§3.2：全部五個條件都成立才回傳 `SplitPlan`，否則 `None`。

    `requirements` 是 job 的 `requirements` dict（`split` 為 `False` 時關閉
    這一件的拆分）；`split_batches` 是平台設定（預設開）。兩個都帶預設值，
    所以純測試可以只餵 workflow。
    """
    if not split_batches:
        return None
    if isinstance(requirements, dict) and requirements.get("split") is False:
        return None

    nodes = _nodes(workflow)
    if not nodes:
        return None

    by_id = {node_id: (class_type, inputs) for node_id, class_type, inputs in nodes}

    # 條件 1：恰好一個批次來源，`batch_size` 是字面 int >= 2。
    sources = [
        (node_id, batch)
        for node_id, class_type, inputs in nodes
        if class_type in BATCH_SOURCE_CLASSES
        and (batch := _literal_int(inputs, "batch_size")) is not None
        and batch >= 2
    ]
    if len(sources) != 1:
        return None
    source_node_id, batch_size = sources[0]

    # 條件 2：沒有其他節點帶 `batch_size` 輸入（不論值）。
    for node_id, _class_type, inputs in nodes:
        if node_id != source_node_id and "batch_size" in inputs:
            return None

    # 條件 3：每個節點的 class_type 都在白名單。
    for _node_id, class_type, _inputs in nodes:
        if class_type not in SPLIT_SAFE_CLASSES:
            return None

    # 條件 4：每個吃 latent 的取樣器都追得到那個批次來源。
    for node_id, class_type, inputs in nodes:
        if not (class_type.startswith("KSampler") or class_type.startswith("SamplerCustom")):
            continue
        latent_field = next((f for f in _LATENT_INPUT_FIELDS if f in inputs), None)
        if latent_field is None:
            # KSamplerSelect 之類根本不吃 latent 的節點：不是 latent 消費者。
            continue
        if not _reaches_batch_source(
            _link_target(inputs[latent_field]), source_node_id, by_id, set()
        ):
            return None

    return SplitPlan(source_node_id=source_node_id, batch_size=batch_size)


def _free_split_node_id(workflow: dict) -> str:
    if _SPLIT_NODE_ID not in workflow:
        return _SPLIT_NODE_ID
    index = 1
    while f"{_SPLIT_NODE_ID}_{index}" in workflow:
        index += 1
    return f"{_SPLIT_NODE_ID}_{index}"


def child_workflow(
    workflow: dict, plan: SplitPlan, start: int, length: int
) -> Optional[dict]:
    """§3.3：深拷貝原圖，插入一個 `LatentFromBatch`，把所有原本引用
    `[source_node_id, 0]` 的輸入改指向它。

    來源節點本身的 `batch_size` **不改**：EmptyLatent 幾乎零成本，而
    `LatentFromBatch` 需要整批 shape 才能算對是哪一片。

    找不到任何引用來源節點的輸入時回 `None` 並記 WARNING（理論上被 §3.2
    條件 4 擋掉，見 spec §5）。
    """
    child = copy.deepcopy(workflow)
    split_node_id = _free_split_node_id(child)

    rewired = 0
    for _node_id, node in child.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for field, value in list(inputs.items()):
            if (
                isinstance(value, list)
                and len(value) >= 2
                and _link_target(value) == plan.source_node_id
                and value[1] == 0
            ):
                inputs[field] = [split_node_id, 0]
                rewired += 1

    if rewired == 0:
        logger.warning(
            "split: no input references batch source node %s; refusing to split",
            plan.source_node_id,
        )
        return None

    child[split_node_id] = {
        "class_type": "LatentFromBatch",
        "inputs": {
            "samples": [plan.source_node_id, 0],
            "batch_index": start,
            "length": length,
        },
    }
    return child


def partition(batch_size: int, k: int) -> list[tuple[int, int]]:
    """§3.3 的分片：k 段連續範圍，前 `B mod k` 段長 `ceil(B/k)`，其餘
    `floor(B/k)`。回傳 `[(start, length), ...]`，`split_index` 就是索引。

    `k` 會先夾在 `1..min(batch_size, MAX_SPLIT)`，所以呼叫端不必自己防呆。
    """
    k = max(1, min(k, batch_size, MAX_SPLIT))
    base, remainder = divmod(batch_size, k)
    ranges: list[tuple[int, int]] = []
    start = 0
    for index in range(k):
        length = base + (1 if index < remainder else 0)
        ranges.append((start, length))
        start += length
    return ranges
```

- [ ] **Step 4: 跑測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_split.py -q`
Expected: PASS

- [ ] **Step 5: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 6: 寫 cloud split 測試**

Create `cloud/test/split.spec.ts`：

```ts
import { describe, expect, it } from "vitest";
import * as split from "../src/core/split";

function batchWorkflow(batchSize = 4, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "wuxia", clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: batchSize } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], steps: 20, seed: 424242 },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
    ...JSON.parse(JSON.stringify(extra)),
  };
}

describe("splitPlan (§3.2 veto conditions)", () => {
  it("accepts a clean batch workflow", () => {
    expect(split.splitPlan(batchWorkflow(4))).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("vetoes batch_size 1", () => expect(split.splitPlan(batchWorkflow(1))).toBeNull());

  it("vetoes a non-literal batch_size", () => {
    const wf = batchWorkflow();
    wf["4"].inputs.batch_size = ["9", 0];
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes two batch sources", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 2 } };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes any other node carrying batch_size", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSampler", inputs: { batch_size: 1, latent_image: ["4", 0] } };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes a node outside the whitelist", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "SomeCustomNode", inputs: {} };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it.each(["ImageBatch", "LatentBatch", "RepeatLatentBatch", "RebatchLatents"])(
    "vetoes the explicitly named batch node %s",
    (classType) => {
      const wf = batchWorkflow();
      wf["8"] = { class_type: classType, inputs: {} };
      expect(split.splitPlan(wf)).toBeNull();
    }
  );

  it("vetoes a sampler whose latent does not come from the batch source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LoadImage", inputs: { image: "x.png" } };
    wf["9"] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["1", 2] } };
    wf["5"].inputs.latent_image = ["9", 0];
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("allows a latent passthrough chain to the batch source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LatentUpscale", inputs: { samples: ["4", 0] } };
    wf["5"].inputs.latent_image = ["8", 0];
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("allows a refiner chain of two samplers", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], latent_image: ["5", 0], steps: 10 } };
    wf["6"].inputs.samples = ["8", 0];
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("ignores KSamplerSelect, which has no latent input", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("vetoes when requirements say no", () => {
    expect(split.splitPlan(batchWorkflow(), { split: false })).toBeNull();
    expect(split.splitPlan(batchWorkflow(), { split: true })).not.toBeNull();
    expect(split.splitPlan(batchWorkflow(), {})).not.toBeNull();
  });

  it("vetoes when the platform setting is off", () => {
    expect(split.splitPlan(batchWorkflow(), null, false)).toBeNull();
  });

  it("handles junk workflows without throwing", () => {
    expect(split.splitPlan({})).toBeNull();
    expect(split.splitPlan({ "1": "not an object" as any })).toBeNull();
    expect(split.splitPlan({ "1": { class_type: 7, inputs: {} } as any })).toBeNull();
  });
});

describe("childWorkflow (§3.3)", () => {
  it("inserts LatentFromBatch and rewires consumers", () => {
    const wf = batchWorkflow(4);
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 2, 2)! as Record<string, any>;

    expect(child["cfsplit"]).toEqual({
      class_type: "LatentFromBatch",
      inputs: { samples: ["4", 0], batch_index: 2, length: 2 },
    });
    expect(child["5"].inputs.latent_image).toEqual(["cfsplit", 0]);
    expect(child["4"].inputs.batch_size).toBe(4);
    expect((wf as any)["5"].inputs.latent_image).toEqual(["4", 0]);
  });

  it("picks a free node id when cfsplit is taken", () => {
    const wf = batchWorkflow();
    wf["cfsplit"] = { class_type: "PreviewImage", inputs: { images: ["6", 0] } };
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 0, 2)! as Record<string, any>;

    expect(child["cfsplit"].class_type).toBe("PreviewImage");
    expect(child["cfsplit_1"].class_type).toBe("LatentFromBatch");
    expect(child["5"].inputs.latent_image).toEqual(["cfsplit_1", 0]);
  });

  it("rewires every consumer of the source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LatentUpscale", inputs: { samples: ["4", 0] } };
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 1, 1)! as Record<string, any>;

    expect(child["5"].inputs.latent_image).toEqual(["cfsplit", 0]);
    expect(child["8"].inputs.samples).toEqual(["cfsplit", 0]);
  });

  it("returns null when nothing references the source", () => {
    const wf = batchWorkflow();
    expect(split.childWorkflow(wf, { sourceNodeId: "no-such-node", batchSize: 4 }, 0, 2)).toBeNull();
  });
});

describe("partition (§3.3)", () => {
  it("splits evenly when it divides", () => {
    expect(split.partition(4, 2)).toEqual([[0, 2], [2, 2]]);
    expect(split.partition(8, 4)).toEqual([[0, 2], [2, 2], [4, 2], [6, 2]]);
  });

  it("gives the remainder to the first children", () => {
    expect(split.partition(5, 2)).toEqual([[0, 3], [3, 2]]);
    expect(split.partition(7, 3)).toEqual([[0, 3], [3, 2], [5, 2]]);
  });

  it("covers the whole batch exactly once", () => {
    for (let batchSize = 2; batchSize < 20; batchSize++) {
      for (let k = 2; k <= Math.min(batchSize, split.MAX_SPLIT); k++) {
        const ranges = split.partition(batchSize, k);
        expect(ranges).toHaveLength(k);
        expect(ranges[0]![0]).toBe(0);
        const covered: number[] = [];
        for (const [start, length] of ranges) {
          expect(length).toBeGreaterThanOrEqual(1);
          for (let i = start; i < start + length; i++) covered.push(i);
        }
        expect(covered).toEqual([...Array(batchSize).keys()]);
      }
    }
  });

  it("returns the whole batch for k = 1", () => expect(split.partition(4, 1)).toEqual([[0, 4]]));
  it("clamps k to the batch size", () => expect(split.partition(2, 5)).toEqual([[0, 1], [1, 1]]));
});
```

- [ ] **Step 7: 實作 `cloud/src/core/split.ts`**

```ts
/**
 * Phase 3.3 §3: 批次拆分。Parity source: `server/comfyfed_server/split.py`。
 * 本檔上半是純函數（可拆判定、子 workflow 重寫、分片）；下半（Task 6）是父
 * job 狀態推導與輸出組裝，那部分要碰 D1。
 *
 * 一致性依據見 spec §3.1：`LatentFromBatch` 會設定 `batch_index`，ComfyUI 的
 * `prepare_noise` 因此逐片產生雜訊並只保留指定片，所以拆出來的第 i 張和整批
 * 跑的第 i 張是「同 seed 同構圖」-- 不是逐位元相同，差異等同於同一個 job 落
 * 在不同 GPU 上本來就有的差異。
 */

export const MAX_SPLIT = 8;

/** §3.2 條件 1：批次來源節點。 */
export const BATCH_SOURCE_CLASSES = ["EmptyLatentImage", "EmptySD3LatentImage"];

/** §3.2 條件 3：白名單，逐字取自 spec。名單外的任何節點（含所有自訂節點、
 * ImageBatch / LatentBatch / RepeatLatentBatch / RebatchLatents、影片節點）
 * 一律不可拆 -- 這是 allowlist，不是 denylist。 */
export const SPLIT_SAFE_CLASSES: ReadonlySet<string> = new Set([
  // 載入
  "CheckpointLoaderSimple",
  "UNETLoader",
  "DualCLIPLoader",
  "TripleCLIPLoader",
  "CLIPLoader",
  "VAELoader",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "ControlNetLoader",
  "UpscaleModelLoader",
  "CLIPVisionLoader",
  "StyleModelLoader",
  "CLIPSetLastLayer",
  // 條件
  "CLIPTextEncode",
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeFlux",
  "ConditioningCombine",
  "ConditioningConcat",
  "ConditioningSetArea",
  "ConditioningSetAreaPercentage",
  "ConditioningZeroOut",
  "ConditioningSetTimestepRange",
  "FluxGuidance",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  // 模型調整
  "ModelSamplingFlux",
  "ModelSamplingSD3",
  "ModelSamplingDiscrete",
  // 取樣
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "RandomNoise",
  "KSamplerSelect",
  "BasicScheduler",
  "BasicGuider",
  "CFGGuider",
  "DisableNoise",
  // Latent / 影像
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "VAEDecode",
  "VAEDecodeTiled",
  "VAEEncode",
  "VAEEncodeForInpaint",
  "SetLatentNoiseMask",
  "LatentUpscale",
  "LatentUpscaleBy",
  "ImageScale",
  "ImageScaleBy",
  "ImageUpscaleWithModel",
  "ImageInvert",
  "ImageCrop",
  "ImagePadForOutpaint",
  "LoadImage",
  "LoadImageMask",
  "SaveImage",
  "PreviewImage",
]);

/** §3.2 條件 4：沿 LATENT 邊往上追時，允許「原封不動傳遞 latent 批次結構」
 * 的中繼節點。VAEEncode 之類「從別的型別造出 latent」的節點刻意不在這裡。 */
const LATENT_PASSTHROUGH_CLASSES: ReadonlySet<string> = new Set([
  "LatentUpscale",
  "LatentUpscaleBy",
  "SetLatentNoiseMask",
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);

const LATENT_INPUT_FIELDS = ["latent_image", "samples"];
const SPLIT_NODE_ID = "cfsplit";

export interface SplitPlan {
  sourceNodeId: string;
  batchSize: number;
}

interface NodeEntry {
  nodeId: string;
  classType: string;
  inputs: Record<string, unknown>;
}

function nodes(workflow: Record<string, unknown> | null | undefined): NodeEntry[] {
  const result: NodeEntry[] = [];
  for (const [nodeId, node] of Object.entries(workflow ?? {})) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record.class_type !== "string") continue;
    const inputs = typeof record.inputs === "object" && record.inputs !== null ? (record.inputs as Record<string, unknown>) : {};
    result.push({ nodeId: String(nodeId), classType: record.class_type, inputs });
  }
  return result;
}

function literalInt(inputs: Record<string, unknown>, field: string): number | null {
  const value = inputs[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

/** ComfyUI API 格式的接線是 `[node_id, slot]`；回傳來源 node_id 字串。 */
function linkTarget(value: unknown): string | null {
  if (Array.isArray(value) && value.length >= 1 && (typeof value[0] === "string" || typeof value[0] === "number")) {
    return String(value[0]);
  }
  return null;
}

function reachesBatchSource(
  nodeId: string | null,
  sourceNodeId: string,
  byId: Map<string, NodeEntry>,
  seen: Set<string>
): boolean {
  if (nodeId === null || seen.has(nodeId)) return false;
  seen.add(nodeId);
  if (nodeId === sourceNodeId) return true;
  const entry = byId.get(nodeId);
  if (!entry) return false;
  if (!LATENT_PASSTHROUGH_CLASSES.has(entry.classType)) return false;
  for (const field of LATENT_INPUT_FIELDS) {
    if (field in entry.inputs) {
      return reachesBatchSource(linkTarget(entry.inputs[field]), sourceNodeId, byId, seen);
    }
  }
  return false;
}

/** §3.2 -- ports `split.split_plan`：五個條件全部成立才回傳計畫。 */
export function splitPlan(
  workflow: Record<string, unknown>,
  requirements?: Record<string, unknown> | null,
  splitBatches = true
): SplitPlan | null {
  if (!splitBatches) return null;
  if (requirements && requirements.split === false) return null;

  const entries = nodes(workflow);
  if (entries.length === 0) return null;
  const byId = new Map(entries.map((e) => [e.nodeId, e] as const));

  // 條件 1
  const sources = entries
    .filter((e) => BATCH_SOURCE_CLASSES.includes(e.classType))
    .map((e) => ({ nodeId: e.nodeId, batchSize: literalInt(e.inputs, "batch_size") }))
    .filter((s): s is { nodeId: string; batchSize: number } => s.batchSize !== null && s.batchSize >= 2);
  if (sources.length !== 1) return null;
  const { nodeId: sourceNodeId, batchSize } = sources[0]!;

  // 條件 2
  for (const entry of entries) {
    if (entry.nodeId !== sourceNodeId && "batch_size" in entry.inputs) return null;
  }

  // 條件 3
  for (const entry of entries) {
    if (!SPLIT_SAFE_CLASSES.has(entry.classType)) return null;
  }

  // 條件 4
  for (const entry of entries) {
    if (!(entry.classType.startsWith("KSampler") || entry.classType.startsWith("SamplerCustom"))) continue;
    const latentField = LATENT_INPUT_FIELDS.find((f) => f in entry.inputs);
    if (latentField === undefined) continue; // KSamplerSelect 之類不吃 latent
    if (!reachesBatchSource(linkTarget(entry.inputs[latentField]), sourceNodeId, byId, new Set())) {
      return null;
    }
  }

  return { sourceNodeId, batchSize };
}

function freeSplitNodeId(workflow: Record<string, unknown>): string {
  if (!(SPLIT_NODE_ID in workflow)) return SPLIT_NODE_ID;
  let index = 1;
  while (`${SPLIT_NODE_ID}_${index}` in workflow) index += 1;
  return `${SPLIT_NODE_ID}_${index}`;
}

/** §3.3 -- ports `split.child_workflow`；找不到任何引用來源節點的輸入時回
 * null 並記 warning（理論上被 §3.2 條件 4 擋掉，見 spec §5）。 */
export function childWorkflow(
  workflow: Record<string, unknown>,
  plan: SplitPlan,
  start: number,
  length: number
): Record<string, unknown> | null {
  const child = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  const splitNodeId = freeSplitNodeId(child);

  let rewired = 0;
  for (const node of Object.values(child)) {
    if (typeof node !== "object" || node === null) continue;
    const inputs = (node as Record<string, unknown>).inputs;
    if (typeof inputs !== "object" || inputs === null) continue;
    const inputRecord = inputs as Record<string, unknown>;
    for (const [field, value] of Object.entries(inputRecord)) {
      if (Array.isArray(value) && value.length >= 2 && linkTarget(value) === plan.sourceNodeId && value[1] === 0) {
        inputRecord[field] = [splitNodeId, 0];
        rewired += 1;
      }
    }
  }

  if (rewired === 0) {
    console.warn(`split: no input references batch source node ${plan.sourceNodeId}; refusing to split`);
    return null;
  }

  child[splitNodeId] = {
    class_type: "LatentFromBatch",
    inputs: { samples: [plan.sourceNodeId, 0], batch_index: start, length },
  };
  return child;
}

/** §3.3 -- ports `split.partition`：前 `B mod k` 段長 `ceil(B/k)`，其餘
 * `floor(B/k)`；`k` 先夾在 `1..min(batchSize, MAX_SPLIT)`。 */
export function partition(batchSize: number, k: number): [number, number][] {
  const count = Math.max(1, Math.min(k, batchSize, MAX_SPLIT));
  const base = Math.floor(batchSize / count);
  const remainder = batchSize % count;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const length = base + (index < remainder ? 1 : 0);
    ranges.push([start, length]);
    start += length;
  }
  return ranges;
}
```

- [ ] **Step 8: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠

- [ ] **Step 9: Commit**

```bash
git add server/comfyfed_server/split.py tests/server/test_split.py cloud/src/core/split.ts cloud/test/split.spec.ts
git commit -F - <<'MSGEOF'
feat(split): batch-split planning and child workflow rewriting

Phase 3.3 Task 5. split.py / core/split.ts implement the spec's §3.2 veto
ladder (single literal batch source, no other batch_size input, whitelist-only
node classes, every sampler's latent tracing back to that source, plus the
per-job and platform opt-outs), the §3.3 LatentFromBatch rewrite, and the
contiguous partition. Pure functions on both stacks, one test per veto.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 6: 拆分落地 — 存檔、tick 拆分步驟、父 job 推導（兩棧）

**Files:**
- Modify: `server/comfyfed_server/split.py`（Task 5 建的檔，補上 DB 層）
- Modify: `server/comfyfed_server/jobs.py:164-182`（`create_job` 存 `split_plan`）、`:582-609`（`retry_job`）
- Modify: `server/comfyfed_server/dispatch.py`（Task 4 改過的 `assign_jobs` 插入拆分步驟；`mark_running`/`mark_done`/`mark_failed`/`cancel_job`/`requeue_stale` 後推導父 job）
- Modify: `server/comfyfed_server/agentws.py:607-668`（`cancel_and_notify` 的串聯取消）
- Modify: `cloud/src/core/split.ts`、`cloud/src/core/dispatch.ts`、`cloud/src/db/queries.ts`、`cloud/src/routes/jobs.ts`、`cloud/src/routes/comfyapi.ts`、`cloud/src/do/hub.ts`
- Test: `tests/server/test_split.py`（補 DB 段）、`tests/server/test_dispatch.py`、`tests/server/test_jobs.py`、`cloud/test/split.spec.ts`、`cloud/test/dispatch.spec.ts`、`cloud/test/jobs.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 `split.split_plan(workflow, requirements, split_batches)`、`split.child_workflow(workflow, plan, start, length)`、`split.partition(batch_size, k)`、`split.SplitPlan`、`split.MAX_SPLIT`；cloud 同名 camelCase。Task 4 的 `dispatch.assign_jobs` / `assignJobs` 主體。
- Produces（Task 7/8/10 依賴）：
  - Python：`split.SPLIT_BATCHES_SETTING_KEY = "split_batches"`；`split.split_batches_enabled(session=None) -> bool`；`split.plan_for_job(workflow: dict, requirements: dict | None) -> str | None`（回傳要存進 `jobs.split_plan` 的 JSON 字串或 None）；`split.create_children(parent_id: str, k: int) -> int`（回傳實際建立的子 job 數，0 = 沒拆）；`split.refresh_parent(parent_id: str) -> tuple[bool, Optional[str]]`；`split.child_status_changed(job_id: str) -> Optional[str]`；`split.parent_outputs(parent: "db.Job") -> list[tuple[str, str]]`；`split.children_of(parent_id: str) -> list["db.Job"]`；`split.create_children_for_tick(session, queued_jobs, workers, all_workers, fetchable_models=None, peer_only_models=None) -> bool`。
  - TS：`SPLIT_BATCHES_SETTING_KEY`；`splitBatchesEnabled(db): Promise<boolean>`；`planForJob(workflow, requirements, splitBatches): string | null`；`createChildren(db, parentId, k, now): Promise<number>`；`refreshParent(db, parentId, now): Promise<{ changed: boolean; status: string | null }>`；`childStatusChanged(db, jobId, now): Promise<string | null>`；`parentOutputs(db, parent: Job): Promise<[string, string][]>`；`childrenOf(db, parentId): Promise<Job[]>`；`createChildrenForTick(db, queuedJobs, workers, allWorkers, fetchableModels?, peerOnlyModels?): Promise<boolean>`。
  - cloud queries 新增：`getChildJobs(db, parentId)`、`insertChildJob(db, child: NewChildJob)`、`markJobSplit(db, jobId, splitCount): Promise<boolean>`、`updateParentDerived(db, jobId, patch)`；既有的 `retryFailedJob` 與 `insertJob` 各擴充一處（清掉／寫入 `split_plan`）。

- [ ] **Step 1: 寫失敗的 Python 測試（父 job 推導 + 拆分落地）**

在 `tests/server/test_split.py` 檔尾加入：

```python
# --- §3.4 父 job 狀態推導 / §3.5 拆分落地 --------------------------------

import json  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

from comfyfed_server import db, dispatch, jobs as jobs_module, metrics  # noqa: E402


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_parent(job_id="parent", batch_size=4, k=0):
    workflow = _batch_workflow(batch_size=batch_size)
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json=json.dumps(workflow),
                status="queued",
                signature="sig",
                required_models=json.dumps([]),
                required_nodes=json.dumps(sorted({n["class_type"] for n in workflow.values()})),
                split_plan=json.dumps({"source_node_id": "4", "batch_size": batch_size}),
                split_count=k,
            )
        )
        session.commit()
    return job_id


def _set_child(child_id, **fields):
    with db.get_session() as session:
        child = session.get(db.Job, child_id)
        for key, value in fields.items():
            setattr(child, key, value)
        session.commit()


def test_create_children_inserts_k_children_and_marks_the_parent(_db):
    parent_id = _make_parent(batch_size=4)

    assert split.create_children(parent_id, 2) == 2

    children = split.children_of(parent_id)
    assert [c.split_index for c in children] == [0, 1]
    assert [c.split_count for c in children] == [0, 0]
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        assert parent.split_count == 2
        assert parent.status == "queued"
    # 子 job 的 workflow 帶了 LatentFromBatch，範圍連續且承襲父的 created_at。
    first = json.loads(children[0].workflow_json)
    second = json.loads(children[1].workflow_json)
    assert first["cfsplit"]["inputs"] == {"samples": ["4", 0], "batch_index": 0, "length": 2}
    assert second["cfsplit"]["inputs"] == {"samples": ["4", 0], "batch_index": 2, "length": 2}
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert all(c.created_at == parent.created_at for c in children)
    assert all(c.signature == parent.signature for c in children)
    assert all("LatentFromBatch" in json.loads(c.required_nodes) for c in children)


def test_create_children_is_a_no_op_without_a_split_plan(_db):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="queued"))
        session.commit()
    assert split.create_children("plain", 2) == 0


@pytest.mark.parametrize(
    "child_statuses,expected",
    [
        (["queued", "queued"], "queued"),
        (["assigned", "queued"], "assigned"),
        (["running", "queued"], "running"),
        (["running", "assigned"], "running"),
        (["done", "done"], "done"),
        (["done", "running"], "running"),
    ],
)
def test_refresh_parent_derives_the_status_table(_db, child_statuses, expected):
    parent_id = _make_parent()
    split.create_children(parent_id, len(child_statuses))
    for child, status in zip(split.children_of(parent_id), child_statuses):
        _set_child(child.id, status=status)

    changed, status = split.refresh_parent(parent_id)

    assert status == expected
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == expected


def test_refresh_parent_running_takes_the_earliest_start_and_average_progress(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    base = _utcnow()
    _set_child(children[0].id, status="running", started_at=base, progress=0.4)
    _set_child(children[1].id, status="running", started_at=base + timedelta(seconds=30), progress=0.8)

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert parent.status == "running"
    assert parent.started_at == base
    assert parent.progress == pytest.approx(0.6)


def test_refresh_parent_done_takes_the_latest_finish(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    base = _utcnow()
    _set_child(children[0].id, status="done", finished_at=base, result_files=json.dumps(["a.png"]))
    _set_child(children[1].id, status="done", finished_at=base + timedelta(seconds=5), result_files=json.dumps(["b.png"]))

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert parent.status == "done"
    assert parent.finished_at == base + timedelta(seconds=5)
    # 父 job 自己的 result_files 保持空的；輸出由 parent_outputs 組出來。
    assert json.loads(parent.result_files) == []


def test_refresh_parent_failure_cancels_the_surviving_siblings(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 3)
    children = split.children_of(parent_id)
    _set_child(children[1].id, status="failed", error="CUDA OOM")

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        statuses = {c.id: session.get(db.Job, c.id).status for c in children}
    assert parent.status == "failed"
    assert parent.error == "子任務 2/3：CUDA OOM"
    assert statuses[children[0].id] == "cancelled"
    assert statuses[children[2].id] == "cancelled"


def test_refresh_parent_cancellation_cancels_the_others(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="cancelled", error="cancelled by admin")

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "cancelled"
        assert session.get(db.Job, children[1].id).status == "cancelled"


def test_refresh_parent_ignores_a_job_whose_split_count_is_zero(_db):
    """重試過的父 job（split_count 重設為 0）一律當普通 job 處理。"""
    parent_id = _make_parent(k=0)
    split.create_children(parent_id, 2)
    with db.get_session() as session:
        session.get(db.Job, parent_id).split_count = 0
        session.get(db.Job, parent_id).status = "queued"
        session.commit()

    changed, status = split.refresh_parent(parent_id)
    assert (changed, status) == (False, None)


def test_parent_outputs_are_ordered_by_split_index_then_file_order(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[1].id, status="done", result_files=json.dumps(["c.png", "d.png"]))
    _set_child(children[0].id, status="done", result_files=json.dumps(["a.png", "b.png"]))

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    outputs = split.parent_outputs(parent)

    assert outputs == [
        (children[0].id, "a.png"),
        (children[0].id, "b.png"),
        (children[1].id, "c.png"),
        (children[1].id, "d.png"),
    ]


def test_child_status_changed_returns_none_for_a_plain_job(_db):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="queued"))
        session.commit()
    assert split.child_status_changed("plain") is None


def test_child_status_changed_propagates_a_child_transition(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="running")

    assert split.child_status_changed(children[0].id) == "running"
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "running"
```

並在 `tests/server/test_jobs.py` 加入：

```python
def test_create_job_stores_a_split_plan_for_a_batch_workflow(_db):
    workflow = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 4}},
        "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 20}},
        "3": {"class_type": "VAEDecode", "inputs": {"samples": ["2", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
    }
    job_id = jobs.create_job(json.dumps(workflow), workflow)
    with db.get_session() as session:
        plan = json.loads(session.get(db.Job, job_id).split_plan)
    assert plan == {"source_node_id": "1", "batch_size": 4}


def test_create_job_respects_requirements_split_false(_db):
    workflow = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 4}},
        "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 20}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }
    job_id = jobs.create_job(json.dumps(workflow), workflow, requirements={"split": False})
    with db.get_session() as session:
        assert session.get(db.Job, job_id).split_plan is None


def test_retry_clears_the_split_plan_and_count(_db, client, csrf):
    """§3.6：重試一律不再拆，整包在一台 worker 跑。"""
    with db.get_session() as session:
        session.add(
            db.Job(
                id="p", workflow_json="{}", status="failed", split_count=2,
                split_plan=json.dumps({"source_node_id": "1", "batch_size": 4}),
            )
        )
        session.commit()

    response = client.post("/api/jobs/p/retry", headers={"X-CSRF": csrf})
    assert response.status_code == 200

    with db.get_session() as session:
        job = session.get(db.Job, "p")
    assert job.status == "queued"
    assert job.split_count == 0
    assert job.split_plan is None
```

> `client` / `csrf` fixture 沿用 `tests/server/test_jobs.py` 既有那組；名稱不同就照該檔的來。

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_split.py tests/server/test_jobs.py -q`
Expected: FAIL（`split` 沒有 `create_children` / `refresh_parent` 等）

- [ ] **Step 3: 在 `split.py` 補上 DB 層**

在 `server/comfyfed_server/split.py` 檔尾（`partition` 之後）加入，並把檔頭的 import 改成 `from . import db`（`copy`/`json`/`logging`/`dataclasses` 已有；`json`、`datetime` 要補）：

```python
# --- DB 層（§3.4-§3.6）-----------------------------------------------------

SPLIT_BATCHES_SETTING_KEY = "split_batches"


def split_batches_enabled(session=None) -> bool:
    """平台設定 `split_batches`（預設 true）。任何非 `"0"` 的值都算開啟，
    和其他 boolean 設定的寬鬆讀法一致；讀不到（沒有這一列、DB 還沒初始化）
    就是預設開。"""

    def _read(s) -> bool:
        row = s.get(db.Setting, SPLIT_BATCHES_SETTING_KEY)
        return True if row is None else row.value != "0"

    if session is not None:
        return _read(session)
    try:
        with db.get_session() as own:
            return _read(own)
    except Exception:
        logger.exception("split: failed to read the split_batches setting")
        return True


def plan_for_job(workflow: dict, requirements: Optional[dict]) -> Optional[str]:
    """送件時算一次，回傳要存進 `jobs.split_plan` 的 JSON 字串（不可拆 =
    None）。存字串而不是存物件，是因為這一欄大多數時候沒人看，解析成本應該
    留給真的要用的人（tick 的拆分步驟）。"""
    plan = split_plan(workflow, requirements, split_batches_enabled())
    if plan is None:
        return None
    return json.dumps({"source_node_id": plan.source_node_id, "batch_size": plan.batch_size})


def _plan_from_json(raw: Optional[str]) -> Optional[SplitPlan]:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    source_node_id = data.get("source_node_id")
    batch_size = data.get("batch_size")
    if not isinstance(source_node_id, str) or not isinstance(batch_size, int) or batch_size < 2:
        return None
    return SplitPlan(source_node_id=source_node_id, batch_size=batch_size)


def children_of(parent_id: str) -> list:
    """`parent_id` 的子 job，依 `split_index` 排序。"""
    with db.get_session() as session:
        return (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )


def create_children(parent_id: str, k: int) -> int:
    """§3.3 + §3.5：在同一個交易裡插入 k 個子 job 並把父 job 的
    `split_count` 設成 k。回傳實際建立的子 job 數，0 代表沒拆。

    交易失敗 -> 父 job 維持原狀（`split_count` 仍 0），本 tick 當作不可拆
    處理，下個 tick 重試（spec §5）。
    """
    try:
        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            if parent is None or parent.status != "queued" or parent.split_count != 0:
                return 0
            plan = _plan_from_json(parent.split_plan)
            if plan is None:
                return 0

            try:
                workflow = json.loads(parent.workflow_json or "{}")
            except (TypeError, ValueError):
                return 0
            if not isinstance(workflow, dict):
                return 0

            try:
                parent_nodes = set(json.loads(parent.required_nodes or "[]"))
            except (TypeError, ValueError):
                parent_nodes = set()
            child_nodes = json.dumps(sorted(parent_nodes | {"LatentFromBatch"}))

            ranges = partition(plan.batch_size, k)
            children = []
            for index, (start, length) in enumerate(ranges):
                child_json = child_workflow(workflow, plan, start, length)
                if child_json is None:
                    return 0
                children.append(
                    db.Job(
                        workflow_json=json.dumps(child_json),
                        status="queued",
                        # 承襲父 job，保住在佇列中的位置與派工資格判定。
                        created_at=parent.created_at,
                        signature=parent.signature,
                        required_nodes=child_nodes,
                        required_models=parent.required_models,
                        est_vram_gb=parent.est_vram_gb,
                        requirements=parent.requirements,
                        input_assets=parent.input_assets,
                        origin=parent.origin,
                        user_id=parent.user_id,
                        parent_id=parent.id,
                        split_index=index,
                    )
                )

            for child in children:
                session.add(child)
            parent.split_count = len(children)
            session.commit()
            return len(children)
    except Exception:
        logger.exception("split: create_children failed for parent %s", parent_id)
        return 0


def refresh_parent(parent_id: str) -> tuple[bool, Optional[str]]:
    """§3.4：由子 job 推導父 job 的狀態，回傳 `(有沒有變, 新狀態)`。

    `split_count == 0`（不是父 job，或重試後被重設）一律回 `(False, None)`，
    這是「重試一律不再拆」的那條規則的實作點：所有以父 job 推導的函數都只在
    `split_count > 0` 時看子 job。
    """
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        if parent is None or parent.split_count <= 0:
            return False, None

        children = (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )
        if not children:
            return False, None

        total = len(children)
        statuses = [c.status for c in children]
        before = (parent.status, parent.progress, parent.started_at, parent.finished_at, parent.error)
        cascade_cancel_ids: list[str] = []

        failed = next((c for c in children if c.status == "failed"), None)
        cancelled = next((c for c in children if c.status == "cancelled"), None)

        if failed is not None:
            parent.status = "failed"
            parent.error = f"子任務 {failed.split_index + 1}/{total}：{failed.error or ''}"
            parent.finished_at = parent.finished_at or _utcnow()
            cascade_cancel_ids = [
                c.id for c in children if c.status in ("queued", "assigned", "running")
            ]
        elif cancelled is not None:
            parent.status = "cancelled"
            parent.error = cancelled.error
            parent.finished_at = parent.finished_at or _utcnow()
            cascade_cancel_ids = [
                c.id for c in children if c.status in ("queued", "assigned", "running")
            ]
        elif all(s == "done" for s in statuses):
            parent.status = "done"
            finishes = [c.finished_at for c in children if c.finished_at is not None]
            parent.finished_at = max(finishes) if finishes else _utcnow()
            parent.progress = 1.0
        elif any(s == "running" for s in statuses):
            parent.status = "running"
            starts = [c.started_at for c in children if c.started_at is not None]
            if starts:
                parent.started_at = min(starts)
            parent.progress = sum(c.progress or 0.0 for c in children) / total
        elif any(s == "assigned" for s in statuses):
            parent.status = "assigned"
            # 父 job 從來沒有自己的 worker：它的工作分散在子 job 身上。
            parent.worker_id = None
        else:
            parent.status = "queued"
            parent.progress = 0.0

        after = (parent.status, parent.progress, parent.started_at, parent.finished_at, parent.error)
        changed = before != after
        new_status = parent.status
        session.commit()

    for child_id in cascade_cancel_ids:
        _cancel_sibling(child_id)

    return changed, new_status


def _cancel_sibling(child_id: str) -> None:
    """取消一個還沒終止的兄弟子 job。

    刻意**不**走 `dispatch.cancel_job`：那個函式尾端會呼叫
    `child_status_changed` -> `refresh_parent`，而我們正是從 `refresh_parent`
    裡呼叫過來的，會變成互相遞迴。這裡直接寫欄位，和 `cancel_job` 寫的是同
    一組（status/error/finished_at/last_worker_id/worker_id），父 job 的狀態
    由外層那一次 `refresh_parent` 負責，不需要再觸發一次。
    """
    with db.get_session() as session:
        child = session.get(db.Job, child_id)
        if child is None or child.status not in ("queued", "assigned", "running"):
            return
        child.status = "cancelled"
        child.error = "sibling failed"
        child.finished_at = _utcnow()
        if child.worker_id is not None:
            child.last_worker_id = child.worker_id
            child.worker_id = None
        session.commit()
    # 持有這個子 job 的 agent 不會在這裡收到 `job_cancelled` 推送 -- 和
    # `dispatch.cancel_job` 一樣靠「所有權已釋放」自癒：那台 worker 之後的
    # 每一次心跳／回報都會落在 not-owned 路徑，由那裡補推一次。


def child_status_changed(job_id: str) -> Optional[str]:
    """子 job 狀態／進度變動後的統一入口。

    不是子 job（沒有 `parent_id`）或父 job 已經不是父 job（`split_count == 0`）
    就什麼都不做並回 None；否則重算父 job 並回傳父 job 的新狀態，讓呼叫端
    決定要不要對面板／console 發事件。
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        parent_id = job.parent_id if job is not None else None
    if not parent_id:
        return None
    _changed, status = refresh_parent(parent_id)
    return status


def parent_outputs(parent) -> list[tuple[str, str]]:
    """§3.4：父 job 對外的輸出 = 子 job 的 `result_files`，依 `split_index`
    再依各自檔案順序串起來，因此和整批一次跑的輸出順序一致。

    回傳 `[(child_id, filename), ...]` -- child_id 是面板 `/view` 用來找到
    真正持有檔案的那個 job 的 `subfolder`。
    """
    if parent is None or (parent.split_count or 0) <= 0:
        return []
    outputs: list[tuple[str, str]] = []
    for child in children_of(parent.id):
        try:
            files = json.loads(child.result_files or "[]")
        except (TypeError, ValueError):
            files = []
        for name in files:
            if isinstance(name, str):
                outputs.append((child.id, name))
    return outputs
```

檔頭補 `import json`、`from datetime import datetime, timezone`，並加：

```python
def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
```

- [ ] **Step 4: `create_job` 與 `retry_job`**

`server/comfyfed_server/jobs.py:170-179` 的 `db.Job(...)`（Task 1 已經加了 `signature=`）再加一行：

```python
            signature=assess.signature(workflow, needs),
            # Phase 3.3 §3.2：送件時就判定可不可拆（含 requirements.split 與
            # 平台設定 split_batches）；不可拆存 NULL。
            split_plan=split.plan_for_job(workflow, requirements or {}),
```

並把 `split` 加進 `jobs.py` 第 13 行的 `from . import ...`。

`server/comfyfed_server/jobs.py:601-607` 目前是：

```python
            job.status = "queued"
            job.worker_id = None
            job.error = None
            job.progress = 0
            job.started_at = None
            job.finished_at = None
            session.commit()
```

改成：

```python
            job.status = "queued"
            job.worker_id = None
            job.error = None
            job.progress = 0
            job.started_at = None
            job.finished_at = None
            # Phase 3.3 §3.6：重試一律不再拆 -- 整包在一台 worker 跑，避免兩
            # 代子 job 混在一起。舊子 job 不動（終止狀態，歷史保留），
            # `parent_id` 仍指向這個 job，但 `split_count == 0` 讓所有父 job
            # 推導函數把它當普通 job 看。
            job.split_count = 0
            job.split_plan = None
            session.commit()
```

- [ ] **Step 5: tick 的拆分步驟（§3.5）**

在 `server/comfyfed_server/dispatch.py` 的 `assign_jobs` 裡，Task 4 寫的

```python
        queued_jobs = (
            session.query(db.Job)
            .filter(db.Job.status == "queued", db.Job.split_count == 0)
            .order_by(db.Job.created_at.asc(), db.Job.id.asc())
            .all()
        )
```

之後、`limit = min(...)` 之前，插入：

```python
        # §3.5：配對之前先決定要不要拆。`consumed` 是「前面的 job 大概會用掉
        # 幾台 worker」的估計而非精確保留 -- 寧可少拆不多拆。
        if split.create_children_for_tick(session, queued_jobs, workers, all_workers, fetchable_models, peer_only_models):
            # 拆過之後 queued 清單變了（子 job 取代父 job），重讀一次。
            queued_jobs = (
                session.query(db.Job)
                .filter(db.Job.status == "queued", db.Job.split_count == 0)
                .order_by(db.Job.created_at.asc(), db.Job.id.asc())
                .all()
            )
```

並在 `split.py` 補上這個函式（放在 `create_children` 之後）：

```python
def create_children_for_tick(
    session,
    queued_jobs: list,
    workers: list,
    all_workers: list,
    fetchable_models: Optional[dict] = None,
    peer_only_models=None,
) -> bool:
    """§3.5：tick 第 2 步與第 3 步之間的拆分決策。回傳有沒有真的拆出東西。

    ```
    consumed = 0
    for j in queued（舊到新）:
        E = 對 j 合格的 idle worker 集合
        if j 不可拆: if E 非空: consumed += 1; continue
        S = |E| - consumed
        k = min(batch_size, S, MAX_SPLIT)
        if k >= 2: 拆成 k 個子 job; consumed += k
        elif E 非空: consumed += 1
    ```
    """
    from . import assess

    total_workers = len(workers)
    consumed = 0
    split_any = False

    for job in queued_jobs:
        try:
            requirements_override = json.loads(job.requirements or "{}")
        except (TypeError, ValueError):
            requirements_override = {}
        needs = assess.needs_from_job(job)
        eligible = sum(
            1
            for worker in workers
            if assess.verdict(
                worker, needs, requirements_override, all_workers, fetchable_models, peer_only_models
            ).kind
            in ("eligible", "eligible_after_fetch")
        )

        plan = _plan_from_json(job.split_plan)
        if plan is None:
            if eligible > 0:
                consumed += 1
            continue

        available = min(eligible, total_workers) - consumed
        k = min(plan.batch_size, available, MAX_SPLIT)
        if k >= 2:
            # 這個 session 已經讀過這些列，先 commit 再讓 create_children 開它
            # 自己的 session，免得兩個 session 同時想寫同一列。
            session.commit()
            created = create_children(job.id, k)
            if created >= 2:
                consumed += created
                split_any = True
                continue
        if eligible > 0:
            consumed += 1

    return split_any
```

並把 `dispatch.py` 檔頭的 import 改成 `from . import assess, db, metrics, scheduler, split, stats`。

- [ ] **Step 6: 子 job 狀態變動時推導父 job**

在 `dispatch.py` 的四個轉移函式各加一行（`mark_running` 的 `session.commit()` 之後、回傳之前；`mark_done`、`mark_failed` 同理；`cancel_job` 在 `session.commit()` 之後）：

```python
    # Phase 3.3 §3.4：子 job 動了就重算父 job（不是子 job 的話是 no-op）。
    split.child_status_changed(job_id)
```

`cancel_job` 用的是 `job_id` 參數名，一樣。

`requeue_stale`（第 243-282 行）在 `session.commit()` 之後、`return requeued` 之前加入：

```python
    # 子 job 被 requeue 之後父 job 可能要從 running 退回 assigned/queued。
    for job_id in requeued:
        split.child_status_changed(job_id)
```

- [ ] **Step 7: 取消的串聯（§3.6）**

`server/comfyfed_server/agentws.py` 的 `cancel_and_notify`（第 607 行）：在它現有的「取消 + 推送」邏輯之後、回傳 True 之前，加入串聯處理：

```python
    # Phase 3.3 §3.6：取消父 job -> 每個未終止的子 job 一併取消並推送；
    # 取消子 job -> 透過 refresh_parent 讓父與其他子一起收攤。
    for child in split.children_of(job_id):
        if child.status in ("queued", "assigned", "running"):
            owner = dispatch.cancel_job(child.id, reason=reason)
            if owner is not None:
                await push_job_cancelled(owner, child.id)
    split.child_status_changed(job_id)
```

並把 `split` 加進 `agentws.py` 的 `from . import ...`。

在 `tests/server/test_dispatch.py` 加入：

```python
def test_cancelling_a_child_cancels_the_parent_and_siblings(_db):
    from comfyfed_server import split as split_module

    parent_id = "p"
    with db.get_session() as session:
        session.add(
            db.Job(
                id=parent_id, workflow_json="{}", status="queued", split_count=2,
                split_plan=json.dumps({"source_node_id": "1", "batch_size": 4}),
            )
        )
        session.add(db.Job(id="c0", workflow_json="{}", status="queued", parent_id=parent_id, split_index=0))
        session.add(db.Job(id="c1", workflow_json="{}", status="running", parent_id=parent_id, split_index=1))
        session.commit()

    dispatch.cancel_job("c0", reason="cancelled by admin")

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "cancelled"
        assert session.get(db.Job, "c1").status == "cancelled"
```

- [ ] **Step 8: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 9: cloud queries 支援子 job**

在 `cloud/src/db/queries.ts` 的 jobs 區塊尾端加入：

```ts
/** Phase 3.3 §3.4: `parentId` 的子 job，依 split_index 排序。 */
export async function getChildJobs(db: D1Database, parentId: string): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE parent_id = ? ORDER BY split_index ASC")
    .bind(parentId)
    .all<JobRow>();
  return results.map(rowToJob);
}

export interface NewChildJob {
  id: string;
  parentId: string;
  splitIndex: number;
  workflowJson: string;
  createdAt: string;
  signature: string | null;
  requiredNodes: string[];
  requiredModels: string[];
  estVramGb: number | null;
  requirements: Record<string, unknown>;
  inputAssets: unknown[];
  origin: string;
  userId: string | null;
}

/** Phase 3.3 §3.3: 插入一個子 job -- 每一欄都承襲父 job，只有 workflow、
 * parent_id、split_index 不同。`created_at` 刻意是父的，保住佇列位置。 */
export async function insertChildJob(db: D1Database, child: NewChildJob): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_nodes, required_models,
                          est_vram_gb, requirements, input_assets, origin, user_id, parent_id, split_index)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      child.id,
      child.workflowJson,
      child.createdAt,
      child.signature,
      JSON.stringify(child.requiredNodes),
      JSON.stringify(child.requiredModels),
      child.estVramGb,
      JSON.stringify(child.requirements),
      JSON.stringify(child.inputAssets),
      child.origin,
      child.userId,
      child.parentId,
      child.splitIndex
    )
    .run();
}

/** 只在父 job 仍然 queued 且尚未被拆時把 split_count 設起來（原子護欄，
 * 和 claimJob 同一個形狀）。 */
export async function markJobSplit(db: D1Database, jobId: string, splitCount: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE jobs SET split_count = ? WHERE id = ? AND status = 'queued' AND split_count = 0")
    .bind(splitCount, jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Phase 3.3 §3.4: 把 refreshParent 推導出來的欄位一次寫回父 job。 */
export async function updateParentDerived(
  db: D1Database,
  jobId: string,
  patch: {
    status: string;
    progress: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    workerId: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      "UPDATE jobs SET status = ?, progress = ?, started_at = ?, finished_at = ?, error = ?, worker_id = ? WHERE id = ?"
    )
    .bind(patch.status, patch.progress, patch.startedAt, patch.finishedAt, patch.error, patch.workerId, jobId)
    .run();
}
```

並把既有的 `retryFailedJob`（第 700-712 行）的 UPDATE 改成同時清掉拆分欄位：

```ts
export async function retryFailedJob(db: D1Database, jobId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, error = NULL, progress = 0,
           started_at = NULL, finished_at = NULL,
           split_count = 0, split_plan = NULL
       WHERE id = ? AND status = 'failed'`
    )
    .bind(jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
```

`insertJob` 再加一個可選欄位 `splitPlan?: string | null`（`NewJob` 加同名欄位，SQL 的欄位與 `?` 各加一個，bind 尾端加 `job.splitPlan ?? null`）。

- [ ] **Step 10: `cloud/src/core/split.ts` 補 DB 層**

在檔尾加入（`queries` 與 `toSqliteTimestamp` 由檔頭 import）：

```ts
import * as queries from "../db/queries";
import { toSqliteTimestamp, type Job } from "../db/queries";
import { extract } from "./assess";

export const SPLIT_BATCHES_SETTING_KEY = "split_batches";

/** 平台設定 `split_batches`（預設 true）。任何非 "0" 的值都算開啟。 */
export async function splitBatchesEnabled(db: D1Database): Promise<boolean> {
  try {
    const value = await queries.getSetting(db, SPLIT_BATCHES_SETTING_KEY);
    return value === null || value === undefined ? true : value !== "0";
  } catch (err) {
    console.error("split: failed to read the split_batches setting", err);
    return true;
  }
}

/** 送件時算一次，回傳要存進 `jobs.split_plan` 的 JSON 字串（不可拆 = null）。 */
export function planForJob(
  workflow: Record<string, unknown>,
  requirements: Record<string, unknown> | null,
  splitBatches: boolean
): string | null {
  const plan = splitPlan(workflow, requirements, splitBatches);
  if (plan === null) return null;
  return JSON.stringify({ source_node_id: plan.sourceNodeId, batch_size: plan.batchSize });
}

function planFromJson(raw: string | null): SplitPlan | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const sourceNodeId = record.source_node_id;
  const batchSize = record.batch_size;
  if (typeof sourceNodeId !== "string" || typeof batchSize !== "number" || !Number.isInteger(batchSize) || batchSize < 2) {
    return null;
  }
  return { sourceNodeId, batchSize };
}

export async function childrenOf(db: D1Database, parentId: string): Promise<Job[]> {
  return queries.getChildJobs(db, parentId);
}

/** §3.3 + §3.5 -- ports `split.create_children`；回傳實際建立的子 job 數。 */
export async function createChildren(db: D1Database, parentId: string, k: number): Promise<number> {
  try {
    const parent = await queries.getJobById(db, parentId);
    if (!parent || parent.status !== "queued" || parent.splitCount !== 0) return 0;
    const plan = planFromJson(parent.splitPlan);
    if (plan === null) return 0;

    let workflow: unknown;
    try {
      workflow = JSON.parse(parent.workflowJson || "{}");
    } catch {
      return 0;
    }
    if (typeof workflow !== "object" || workflow === null) return 0;
    const wf = workflow as Record<string, unknown>;

    const childNodes = [...new Set([...parent.requiredNodes, "LatentFromBatch"])].sort();
    const ranges = partition(plan.batchSize, k);
    const children: queries.NewChildJob[] = [];
    for (let index = 0; index < ranges.length; index++) {
      const [start, length] = ranges[index]!;
      const childJson = childWorkflow(wf, plan, start, length);
      if (childJson === null) return 0;
      children.push({
        id: crypto.randomUUID(),
        parentId: parent.id,
        splitIndex: index,
        workflowJson: JSON.stringify(childJson),
        // 承襲父 job，保住在佇列中的位置與派工資格判定。
        createdAt: parent.createdAt,
        signature: parent.signature,
        requiredNodes: childNodes,
        requiredModels: parent.requiredModels,
        estVramGb: parent.estVramGb,
        requirements: parent.requirements,
        inputAssets: parent.inputAssets,
        origin: parent.origin,
        userId: parent.userId,
      });
    }

    // D1 沒有跨 statement 的交易，所以先用一個原子護欄把父 job 標成已拆
    // （`WHERE status='queued' AND split_count=0`）；搶輸了就整個放棄，
    // 這輪當作不可拆處理，下個 tick 重試（spec §5）。
    if (!(await queries.markJobSplit(db, parent.id, children.length))) return 0;

    for (const child of children) {
      await queries.insertChildJob(db, child);
    }
    return children.length;
  } catch (err) {
    console.error(`split: createChildren failed for parent ${parentId}`, err);
    return 0;
  }
}

/** §3.4 -- ports `split.refresh_parent`. */
export async function refreshParent(
  db: D1Database,
  parentId: string,
  now: Date
): Promise<{ changed: boolean; status: string | null }> {
  const parent = await queries.getJobById(db, parentId);
  if (!parent || parent.splitCount <= 0) return { changed: false, status: null };

  const children = await queries.getChildJobs(db, parentId);
  if (children.length === 0) return { changed: false, status: null };

  const total = children.length;
  const nowStamp = toSqliteTimestamp(now);
  const patch = {
    status: parent.status,
    progress: parent.progress,
    startedAt: parent.startedAt,
    finishedAt: parent.finishedAt,
    error: parent.error,
    workerId: parent.workerId,
  };
  let cascadeCancelIds: string[] = [];

  const failed = children.find((c) => c.status === "failed");
  const cancelled = children.find((c) => c.status === "cancelled");
  const live = (c: Job) => c.status === "queued" || c.status === "assigned" || c.status === "running";

  if (failed) {
    patch.status = "failed";
    patch.error = `子任務 ${(failed.splitIndex ?? 0) + 1}/${total}：${failed.error ?? ""}`;
    patch.finishedAt = patch.finishedAt ?? nowStamp;
    cascadeCancelIds = children.filter(live).map((c) => c.id);
  } else if (cancelled) {
    patch.status = "cancelled";
    patch.error = cancelled.error;
    patch.finishedAt = patch.finishedAt ?? nowStamp;
    cascadeCancelIds = children.filter(live).map((c) => c.id);
  } else if (children.every((c) => c.status === "done")) {
    patch.status = "done";
    const finishes = children.map((c) => c.finishedAt).filter((f): f is string => f !== null);
    patch.finishedAt = finishes.length > 0 ? finishes.slice().sort()[finishes.length - 1]! : nowStamp;
    patch.progress = 1;
  } else if (children.some((c) => c.status === "running")) {
    patch.status = "running";
    const starts = children.map((c) => c.startedAt).filter((s): s is string => s !== null);
    if (starts.length > 0) patch.startedAt = starts.slice().sort()[0]!;
    patch.progress = children.reduce((sum, c) => sum + (c.progress || 0), 0) / total;
  } else if (children.some((c) => c.status === "assigned")) {
    patch.status = "assigned";
    patch.workerId = null; // 父 job 從來沒有自己的 worker
  } else {
    patch.status = "queued";
    patch.progress = 0;
  }

  const changed =
    patch.status !== parent.status ||
    patch.progress !== parent.progress ||
    patch.startedAt !== parent.startedAt ||
    patch.finishedAt !== parent.finishedAt ||
    patch.error !== parent.error;

  if (changed) await queries.updateParentDerived(db, parentId, patch);

  for (const childId of cascadeCancelIds) {
    await queries.updateJobCancelled(db, childId, "sibling failed", nowStamp, null);
  }

  return { changed, status: patch.status };
}

/** 子 job 狀態／進度變動後的統一入口 -- ports `split.child_status_changed`. */
export async function childStatusChanged(db: D1Database, jobId: string, now: Date): Promise<string | null> {
  const job = await queries.getJobById(db, jobId);
  if (!job || !job.parentId) return null;
  const { status } = await refreshParent(db, job.parentId, now);
  return status;
}

/** §3.4 -- ports `split.parent_outputs`：`[(childId, filename), ...]`，依
 * split_index 再依各自檔案順序。 */
export async function parentOutputs(db: D1Database, parent: Job): Promise<[string, string][]> {
  if (!parent || parent.splitCount <= 0) return [];
  const outputs: [string, string][] = [];
  for (const child of await queries.getChildJobs(db, parent.id)) {
    for (const name of child.resultFiles) {
      if (typeof name === "string") outputs.push([child.id, name]);
    }
  }
  return outputs;
}

/** §3.5 -- ports `split.create_children_for_tick`；回傳有沒有真的拆出東西。 */
export async function createChildrenForTick(
  db: D1Database,
  queuedJobs: Job[],
  workers: queries.Worker[],
  allWorkers: queries.Worker[],
  fetchableModels?: Record<string, number> | null,
  peerOnlyModels?: ReadonlySet<string> | null
): Promise<boolean> {
  const { needsFromJob, verdict } = await import("./assess");
  let consumed = 0;
  let splitAny = false;

  for (const job of queuedJobs) {
    const needs = needsFromJob(job);
    const eligible = workers.filter((w) => {
      const kind = verdict(w, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels).kind;
      return kind === "eligible" || kind === "eligible_after_fetch";
    }).length;

    const plan = planFromJson(job.splitPlan);
    if (plan === null) {
      if (eligible > 0) consumed += 1;
      continue;
    }

    const available = Math.min(eligible, workers.length) - consumed;
    const k = Math.min(plan.batchSize, available, MAX_SPLIT);
    if (k >= 2) {
      const created = await createChildren(db, job.id, k);
      if (created >= 2) {
        consumed += created;
        splitAny = true;
        continue;
      }
    }
    if (eligible > 0) consumed += 1;
  }

  return splitAny;
}
```

> `extract` 在上面沒用到，別 import 它（`tsc --noEmit` 會抓 unused）。
> `./assess` 用動態 `await import` 是為了避免 `assess -> split -> assess` 的
> 循環；若實際上沒有循環，改成檔頭靜態 import 更好。

- [ ] **Step 11: cloud 的 tick 拆分步驟與父 job 推導**

`cloud/src/core/dispatch.ts` 的 `assignJobs` 裡，Task 4 寫的
`const queuedJobs = await queries.getQueuedJobsForDispatch(db);` 之後插入：

```ts
  // §3.5：配對之前先決定要不要拆。拆過之後 queued 清單變了（子 job 取代父
  // job），重讀一次。
  let jobsForMatching = queuedJobs;
  if (await split.createChildrenForTick(db, queuedJobs, idleWorkers, allWorkers, fetchableModels, peerOnlyModels)) {
    jobsForMatching = await queries.getQueuedJobsForDispatch(db);
  }
```

並把之後所有用到 `queuedJobs` 的地方改成 `jobsForMatching`。檔頭補
`import * as split from "./split";`。

`cloud/src/core/dispatch.ts` 的 `markRunning` / `markDone` / `markFailed` / `cancelJob` 各自在寫入之後、回傳之前加一行：

```ts
  await split.childStatusChanged(db, jobId, now);
```

`requeueStale` 在 `requeued.push(...jobIds)` 之後加入：

```ts
    for (const jobId of jobIds) {
      await split.childStatusChanged(db, jobId, now);
    }
```

`cloud/src/do/hub.ts` 的取消入口（`handleCancel` / `cancelAndNotify` 附近，用
`grep -n "cancelJob\|sendJobCancelled" cloud/src/do/hub.ts` 定位）在取消成功後加入串聯：

```ts
    // Phase 3.3 §3.6：取消父 job -> 每個未終止的子 job 一併取消並推送。
    for (const child of await split.childrenOf(db, jobId)) {
      if (child.status === "queued" || child.status === "assigned" || child.status === "running") {
        const owner = await dispatch.cancelJob(db, child.id, reason, now);
        if (owner) await this.pushJobCancelled(owner, child.id);
      }
    }
    await split.childStatusChanged(db, jobId, now);
```

- [ ] **Step 12: cloud 送件端存 split_plan**

`cloud/src/routes/jobs.ts:334-345` 的 `insertJob(...)` 加一行：

```ts
    splitPlan: split.planForJob(workflow, requirements, await split.splitBatchesEnabled(c.env.DB)),
```

`cloud/src/routes/comfyapi.ts:552-563` 的 `insertJob(...)` 加一行：

```ts
    splitPlan: split.planForJob(promptObj, {}, await split.splitBatchesEnabled(c.env.DB)),
```

兩個檔頭都補 `import * as split from "../core/split";`。

- [ ] **Step 13: 寫 cloud 對應測試**

在 `cloud/test/split.spec.ts` 檔尾加入 DB 段（沿用 `cloud/test/dispatch.spec.ts` 的 `db()` / `afterEach` 清表樣式，這個檔要自己加一份）：

```ts
import { afterEach } from "vitest";
import { env } from "cloudflare:test";
import { toSqliteTimestamp } from "../src/db/queries";

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM settings").run();
});

async function makeParent(id = "parent", batchSize = 4): Promise<string> {
  const wf = batchWorkflow(batchSize);
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_nodes, required_models, split_plan, split_count)
       VALUES (?, ?, 'queued', ?, 'sig', ?, '[]', ?, 0)`
    )
    .bind(
      id,
      JSON.stringify(wf),
      toSqliteTimestamp(new Date()),
      JSON.stringify([...new Set(Object.values(wf).map((n: any) => n.class_type))].sort()),
      JSON.stringify({ source_node_id: "4", batch_size: batchSize })
    )
    .run();
  return id;
}

async function setChild(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  await db()
    .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id)
    .run();
}

describe("createChildren / refreshParent (§3.3-§3.4)", () => {
  it("inserts k children and marks the parent", async () => {
    const parentId = await makeParent("p1", 4);
    expect(await split.createChildren(db(), parentId, 2)).toBe(2);

    const children = await split.childrenOf(db(), parentId);
    expect(children.map((c) => c.splitIndex)).toEqual([0, 1]);
    expect(children.every((c) => c.splitCount === 0)).toBe(true);
    const parent = (await db().prepare("SELECT split_count, created_at FROM jobs WHERE id = ?").bind(parentId).first<any>())!;
    expect(parent.split_count).toBe(2);
    expect(children.every((c) => c.createdAt === parent.created_at)).toBe(true);

    const first = JSON.parse(children[0]!.workflowJson);
    const second = JSON.parse(children[1]!.workflowJson);
    expect(first["cfsplit"].inputs).toEqual({ samples: ["4", 0], batch_index: 0, length: 2 });
    expect(second["cfsplit"].inputs).toEqual({ samples: ["4", 0], batch_index: 2, length: 2 });
    expect(children.every((c) => c.requiredNodes.includes("LatentFromBatch"))).toBe(true);
  });

  it.each([
    [["queued", "queued"], "queued"],
    [["assigned", "queued"], "assigned"],
    [["running", "queued"], "running"],
    [["done", "done"], "done"],
    [["done", "running"], "running"],
  ])("derives %s -> %s", async (statuses, expected) => {
    const parentId = await makeParent(`p-${expected}-${statuses.join("")}`);
    await split.createChildren(db(), parentId, statuses.length);
    const children = await split.childrenOf(db(), parentId);
    for (let i = 0; i < statuses.length; i++) await setChild(children[i]!.id, { status: statuses[i] });

    const { status } = await split.refreshParent(db(), parentId, new Date());
    expect(status).toBe(expected);
  });

  it("takes the earliest start and the average progress while running", async () => {
    const parentId = await makeParent("p-running");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setChild(children[0]!.id, { status: "running", started_at: "2026-09-15 12:00:00.000000", progress: 0.4 });
    await setChild(children[1]!.id, { status: "running", started_at: "2026-09-15 12:00:30.000000", progress: 0.8 });

    await split.refreshParent(db(), parentId, new Date());

    const parent = (await db().prepare("SELECT status, started_at, progress FROM jobs WHERE id = ?").bind(parentId).first<any>())!;
    expect(parent.status).toBe("running");
    expect(parent.started_at).toBe("2026-09-15 12:00:00.000000");
    expect(parent.progress).toBeCloseTo(0.6, 10);
  });

  it("cancels the surviving siblings when one child fails", async () => {
    const parentId = await makeParent("p-failed");
    await split.createChildren(db(), parentId, 3);
    const children = await split.childrenOf(db(), parentId);
    await setChild(children[1]!.id, { status: "failed", error: "CUDA OOM" });

    await split.refreshParent(db(), parentId, new Date());

    const parent = (await db().prepare("SELECT status, error FROM jobs WHERE id = ?").bind(parentId).first<any>())!;
    expect(parent.status).toBe("failed");
    expect(parent.error).toBe("子任務 2/3：CUDA OOM");
    for (const idx of [0, 2]) {
      const row = (await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(children[idx]!.id).first<any>())!;
      expect(row.status).toBe("cancelled");
    }
  });

  it("ignores a job whose split_count is zero (retried parent)", async () => {
    const parentId = await makeParent("p-retried");
    await split.createChildren(db(), parentId, 2);
    await setChild(parentId, { split_count: 0, status: "queued" });
    expect(await split.refreshParent(db(), parentId, new Date())).toEqual({ changed: false, status: null });
  });

  it("orders parent outputs by split index then file order", async () => {
    const parentId = await makeParent("p-outputs");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setChild(children[1]!.id, { status: "done", result_files: JSON.stringify(["c.png", "d.png"]) });
    await setChild(children[0]!.id, { status: "done", result_files: JSON.stringify(["a.png", "b.png"]) });

    const parent = (await import("../src/db/queries")).getJobById;
    const parentRow = (await parent(db(), parentId))!;
    expect(await split.parentOutputs(db(), parentRow)).toEqual([
      [children[0]!.id, "a.png"],
      [children[0]!.id, "b.png"],
      [children[1]!.id, "c.png"],
      [children[1]!.id, "d.png"],
    ]);
  });
});
```

- [ ] **Step 14: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠

- [ ] **Step 15: Commit**

```bash
git add server/comfyfed_server/split.py server/comfyfed_server/jobs.py server/comfyfed_server/dispatch.py server/comfyfed_server/agentws.py tests/server/test_split.py tests/server/test_jobs.py tests/server/test_dispatch.py cloud/src/core/split.ts cloud/src/core/dispatch.ts cloud/src/db/queries.ts cloud/src/routes/jobs.ts cloud/src/routes/comfyapi.ts cloud/src/do/hub.ts cloud/test/split.spec.ts
git commit -F - <<'MSGEOF'
feat(split): persist split plans, split during the tick, derive parent state

Phase 3.3 Task 6. create_job/insertJob store the §3.2 split plan; the dispatch
tick runs the §3.5 consumed-estimate decision before matching and swaps the
parent out for its children; parent status/progress/outputs derive from the
children per §3.4; cancel cascades both directions and retry clears the plan
per §3.6.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 7: 對外呈現 — console / 面板 / 設定（兩棧）

**Files:**
- Modify: `server/comfyfed_server/jobs.py:185-234`（`_job_dict` / `_job_dict_full`）、`:328-371`（`list_jobs` / `get_job`）
- Modify: `server/comfyfed_server/comfyapi.py:589-694`（`job_outputs` / `_history_entry`）、`:1110-1129`（`/queue`）、`:1232-1281`（`/history`）、`:1328-1400`（`/view`）
- Modify: `server/comfyfed_server/panelws.py:162-190`（`_job_owner` / `_visible_to` 之外新增子 job 抑制）、`:269-295`（`job_progress`）、`:349-392`（`job_done`）
- Modify: `server/comfyfed_server/auth.py:403-411`（`SettingsBody`）、`:417-428`（`_current_settings`）、`:480-487`（驗證）
- Modify: `cloud/src/routes/jobs.ts`、`cloud/src/routes/comfyapi.ts`、`cloud/src/routes/settings.ts:32-52` 與 `:91-99`、`cloud/src/do/hub.ts`（panel 事件）
- Test: `tests/server/test_jobs.py`、`tests/server/test_comfyapi.py`、`tests/server/test_comfy_panel_ws.py`、`tests/server/test_auth.py`、`cloud/test/jobs.spec.ts`、`cloud/test/comfyapi.spec.ts`、`cloud/test/panel-ws.spec.ts`、`cloud/test/settings.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `split.children_of(parent_id)`、`split.parent_outputs(parent)`、`split.SPLIT_BATCHES_SETTING_KEY`、`split.split_batches_enabled(session=None)`；cloud 的 `childrenOf(db, parentId)`、`parentOutputs(db, parent)`、`SPLIT_BATCHES_SETTING_KEY`、`splitBatchesEnabled(db)`。
- Produces（Task 8/10 依賴）：
  - `GET /api/jobs`：預設只列 `parent_id IS NULL`，每列多帶 `split_count: int`；`?include_children=1` 列全部。
  - `GET /api/jobs/{id}`：父 job（`split_count > 0`）回 `receipt: null`、`children: [{id, split_index, status, worker_id, progress, gpu_seconds, error}]`、`gpu_seconds_total: float`；每個 job 都多帶 `dispatch_info: dict`、`split_count: int`。非父 job 的 `children` 是 `[]`、`gpu_seconds_total` 是自己收據的 gpu_seconds（沒有收據時 0.0）。
  - `GET /api/settings` / `POST /api/settings` 多一個 `split_batches: bool`。
  - Python `comfyapi.job_outputs(job)` 對父 job 用 `split.parent_outputs` 組出 `{"filename", "subfolder": <child_id>, "type": "output"}`。

- [ ] **Step 1: 寫失敗的 Python console 測試**

在 `tests/server/test_jobs.py` 加入：

```python
def _make_split_family(_session_factory=None):
    """一個父 job 加兩個子 job，子 job 各有一張完成收據。"""
    with db.get_session() as session:
        session.add(db.Job(id="p", workflow_json="{}", status="done", split_count=2, user_id="u1"))
        for index, child_id in enumerate(("c0", "c1")):
            session.add(
                db.Job(
                    id=child_id, workflow_json="{}", status="done", parent_id="p",
                    split_index=index, worker_id=f"w{index}", progress=1.0,
                    result_files=json.dumps([f"{child_id}.png"]), user_id="u1",
                )
            )
            session.add(
                db.Receipt(
                    id=f"r{index}", job_id=child_id, worker_id=f"w{index}",
                    gpu_seconds=10.0 * (index + 1), platform_sig="sig",
                    kind="completed", billable=True,
                )
            )
        session.commit()


def test_list_jobs_hides_children_by_default(_db, client, admin_cookie):
    _make_split_family()
    rows = client.get("/api/jobs", cookies=admin_cookie).json()
    assert [r["id"] for r in rows] == ["p"]
    assert rows[0]["split_count"] == 2


def test_list_jobs_include_children_shows_everything(_db, client, admin_cookie):
    _make_split_family()
    rows = client.get("/api/jobs?include_children=1", cookies=admin_cookie).json()
    assert sorted(r["id"] for r in rows) == ["c0", "c1", "p"]


def test_get_job_on_a_parent_returns_children_and_gpu_total(_db, client, admin_cookie):
    _make_split_family()
    body = client.get("/api/jobs/p", cookies=admin_cookie).json()
    assert body["receipt"] is None
    assert body["split_count"] == 2
    assert body["gpu_seconds_total"] == pytest.approx(30.0)
    assert [c["split_index"] for c in body["children"]] == [0, 1]
    assert body["children"][0] == {
        "id": "c0", "split_index": 0, "status": "done", "worker_id": "w0",
        "progress": 1.0, "gpu_seconds": 10.0, "error": None,
    }


def test_get_job_on_a_plain_job_has_empty_children(_db, client, admin_cookie):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="queued", user_id="u1"))
        session.commit()
    body = client.get("/api/jobs/plain", cookies=admin_cookie).json()
    assert body["children"] == []
    assert body["gpu_seconds_total"] == 0.0
    assert body["split_count"] == 0


def test_job_dict_exposes_dispatch_info(_db, client, admin_cookie):
    with db.get_session() as session:
        session.add(
            db.Job(
                id="j1", workflow_json="{}", status="assigned", user_id="u1",
                dispatch_info=json.dumps({"predicted_seconds": 41.2, "basis": "signature",
                                          "load_seconds": 0.0, "fetch_seconds": 0.0, "candidates": 3}),
            )
        )
        session.commit()
    body = client.get("/api/jobs/j1", cookies=admin_cookie).json()
    assert body["dispatch_info"]["basis"] == "signature"
    assert body["dispatch_info"]["predicted_seconds"] == pytest.approx(41.2)
```

> `client` / `admin_cookie` fixture 沿用 `tests/server/test_jobs.py` 既有那組；
> 名稱不同就照該檔的來。

- [ ] **Step 2: 跑測試確認失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/server/test_jobs.py -q -k "children or dispatch_info or gpu_total"`
Expected: FAIL（`KeyError: 'children'` 等）

- [ ] **Step 3: 改 console job 字典與路由**

`server/comfyfed_server/jobs.py:185-208` 的 `_job_dict` 在 `"est_vram_gb": job.est_vram_gb,` 之後加入兩行：

```python
        # Phase 3.3：拆分與派工依據，列表與詳細頁共用（Web UI 的徽章與
        # 詳細頁的「預估秒數與依據」都讀這兩個欄位）。
        "split_count": job.split_count or 0,
        "dispatch_info": _json_dict(job.dispatch_info),
```

並在 `_job_dict` 之前加：

```python
def _json_dict(raw) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}
```

`_job_dict_full`（第 224-234 行）目前最後一行是 `d["receipt"] = _receipt_dict(receipt) if receipt is not None else None`。整個函式改成：

```python
def _job_dict_full(job: db.Job, receipt: Optional["db.Receipt"] = None) -> dict:
    d = _job_dict(job)
    d["workflow_json"] = json.loads(job.workflow_json)
    d["requirements"] = json.loads(job.requirements or "{}")
    d["required_nodes"] = json.loads(job.required_nodes or "[]")
    d["required_models"] = json.loads(job.required_models or "[]")
    d["started_at"] = job.started_at.isoformat() if job.started_at else None
    d["finished_at"] = job.finished_at.isoformat() if job.finished_at else None
    d["result_hashes"] = json.loads(job.result_hashes or "{}")

    # Phase 3.3 §3.7：父 job 沒有自己的收據（子 job 各自一張），所以
    # `receipt` 一律 None，改看 `children` 與 `gpu_seconds_total`。
    if (job.split_count or 0) > 0:
        d["receipt"] = None
        d["children"], d["gpu_seconds_total"] = _children_summary(job.id)
    else:
        d["receipt"] = _receipt_dict(receipt) if receipt is not None else None
        d["children"] = []
        d["gpu_seconds_total"] = receipt.gpu_seconds if receipt is not None else 0.0
    return d


def _children_summary(parent_id: str) -> tuple[list[dict], float]:
    """`(children, gpu_seconds_total)` -- 子 job 摘要與 billable 收據加總。

    一次把子 job 的收據全撈進來，而不是每個子 job 一次查詢：一個父 job 最多
    `split.MAX_SPLIT` 個子，但這條路徑是詳細頁每次開啟都會走的。
    """
    children = split.children_of(parent_id)
    child_ids = [c.id for c in children]
    gpu_by_job: dict[str, float] = {}
    if child_ids:
        with db.get_session() as session:
            rows = (
                session.query(db.Receipt)
                .filter(db.Receipt.job_id.in_(child_ids), db.Receipt.billable == True)  # noqa: E712
                .all()
            )
        for row in rows:
            gpu_by_job[row.job_id] = gpu_by_job.get(row.job_id, 0.0) + row.gpu_seconds

    summary = [
        {
            "id": c.id,
            "split_index": c.split_index,
            "status": c.status,
            "worker_id": c.worker_id,
            "progress": c.progress,
            "gpu_seconds": gpu_by_job.get(c.id, 0.0),
            "error": c.error,
        }
        for c in children
    ]
    return summary, sum(gpu_by_job.values())
```

`list_jobs`（第 328-354 行）的簽名與查詢加上 `include_children`：

```python
    @r.get("/api/jobs")
    def list_jobs(
        status: Optional[str] = None,
        include_children: int = 0,
        user: auth.SessionUser = Depends(auth.require_user),
    ):
        is_admin = user.role == "admin"
        with db.get_session() as session:
            query = session.query(db.Job)
            if not include_children:
                # Phase 3.3 §3.7：預設只列父／普通 job；子 job 是實作細節，
                # 要看得加 ?include_children=1。
                query = query.filter(db.Job.parent_id == None)  # noqa: E711
            if not is_admin:
                query = query.filter(db.Job.user_id == user.uid)
            ...（以下不變）
```

並把 `split` 加進 `jobs.py` 的 `from . import ...`（Task 6 已經加過就不用再加）。

- [ ] **Step 4: 面板 `job_outputs` / `/queue` / `/history` / `/view` 只看父 job**

`server/comfyfed_server/comfyapi.py:589` 的 `job_outputs` 開頭目前是：

```python
    files = _result_files(job)
    if not files:
        return {}

    text_files = [f for f in files if os.path.splitext(f)[1].lower() == _TEXT_ARTIFACT_EXT]
    media_files = [f for f in files if f not in text_files]
```

改成（父 job 用子 job 的輸出，`subfolder` 是持有檔案的子 job id）：

```python
    # Phase 3.3 §3.7：父 job 自己的 result_files 永遠是空的 -- 輸出由
    # `split.parent_outputs` 依 split_index 再依各子 job 的檔案順序組出來，
    # 所以和整批一次跑的輸出順序一致。`subfolder` 帶的是子 job id，`/view`
    # 就能找到真正持有位元組的那個 job。
    if (job.split_count or 0) > 0:
        pairs = split.parent_outputs(job)
        if not pairs:
            return {}
        subfolder_of = {name: child_id for child_id, name in pairs}
        files = [name for _child_id, name in pairs]
    else:
        files = _result_files(job)
        if not files:
            return {}
        subfolder_of = {name: job.id for name in files}

    text_files = [f for f in files if os.path.splitext(f)[1].lower() == _TEXT_ARTIFACT_EXT]
    media_files = [f for f in files if f not in text_files]
```

再把該函式內三處 `"subfolder": job.id` 全部換成 `"subfolder": subfolder_of[name]`（媒體那一處在 `"images": [...]` 的生成式裡，文字那兩處在 `file_entries` 裡）。`comfyapi.py` 檔頭補 `split` 到 `from . import ...`。

`/queue`（第 1110-1129 行）的 `.filter(...)` 加一條：

```python
                    db.Job.parent_id == None,  # noqa: E711
```

`/history`（第 1247-1253 行）的 `.filter(...)` 同樣加 `db.Job.parent_id == None,  # noqa: E711`；`/history/{prompt_id}`（第 1266-1273 行）的條件加 `or job.parent_id is not None`。

`/view`（第 1359-1377 行）目前 `subfolder` 分支是：

```python
            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                if (
                    job is None
                    or safe_name not in _result_files(job)
                    or job.origin != "panel"
                    or job.user_id != user.uid
                ):
                    return Response(status_code=404)
```

不用改：`subfolder` 現在可能是子 job 的 id，而子 job 的 `origin` / `user_id` 都承襲父 job（Task 6 的 `create_children`），所以同一組授權檢查照舊成立，`_result_files(child)` 也確實含那個檔名。**在這一段上面加一行註解說明這件事**：

```python
            # Phase 3.3 §3.7：拆分後 `subfolder` 可能是子 job 的 id。子 job 的
            # origin/user_id 都承襲父 job，所以下面這組授權檢查原封不動就成立。
```

- [ ] **Step 5: panelws 抑制子 job 事件、改發父 job 事件**

在 `server/comfyfed_server/panelws.py` 的 `_job_owner`（第 162 行）之後加入：

```python
def resolve_panel_job_id(job_id: Optional[str]) -> Optional[str]:
    """Phase 3.3 §3.7：面板只看得到父 job。

    傳進來的是子 job 就回它的父 job id；是普通 job／父 job 就原樣回傳；
    job 不存在回 None。所有 job 相關的事件都先過這一關，子 job 的每一次狀態
    變更因此都變成對父 job 發的事件，面板完全不知道拆分存在。
    """
    if not job_id:
        return None
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return None
        return job.parent_id or job.id
```

然後把 `job_progress` / `job_running` / `job_requeued` / `job_cancelled` / `job_failed` 五個函式開頭各加一行把 `job_id` 換成父 job id，例如 `job_progress`（第 269 行）：

```python
async def job_progress(
    job_id: str,
    progress: float,
    *,
    stage: Optional[str] = None,
    fetch_pct: Optional[float] = None,
    fetch_model: Optional[str] = None,
) -> None:
    ...docstring 末尾補一句...
    # Phase 3.3 §3.7：子 job 對面板不可見 -- 事件改掛在父 job 上。
    panel_job_id = resolve_panel_job_id(job_id)
    if panel_job_id is None:
        return
    job_id = panel_job_id
    data = {"value": int(progress * 100), "max": 100, "prompt_id": job_id}
```

`job_done(job)` 拿的是整個 row（第 349 行），改成：

```python
async def job_done(job: "db.Job") -> None:
    ...
    from . import comfyapi

    # Phase 3.3 §3.7：子 job 完成時，面板要看到的是父 job 的 executed。父 job
    # 還沒全部完成就什麼都不發（progress 事件已經在帶進度了），全部完成才把
    # 合併後的輸出一次送出去。
    if job.parent_id:
        with db.get_session() as session:
            parent = session.get(db.Job, job.parent_id)
        if parent is None or parent.status != "done":
            await post_event({"type": "status", "data": {"status": queue_status()}})
            return
        job = parent

    outputs = comfyapi.job_outputs(job) or {comfyapi.FALLBACK_OUTPUT_KEY: {}}
    ...（以下不變）
```

`queue_status()`（第 140 行）計算佇列長度的查詢加上 `db.Job.parent_id == None`（`# noqa: E711`），免得一個拆成 4 份的 job 讓面板的佇列徽章跳成 4。

在 `tests/server/test_comfy_panel_ws.py` 加入：

```python
@pytest.mark.anyio
async def test_child_progress_is_reported_as_the_parent(_db, panel):
    with db.get_session() as session:
        session.add(db.Job(id="p", workflow_json="{}", status="running", origin="panel", user_id="u1", split_count=2))
        session.add(db.Job(id="c0", workflow_json="{}", status="running", origin="panel", user_id="u1", parent_id="p", split_index=0))
        session.commit()

    await panelws.job_progress("c0", 0.5)

    evt = await panel.next_event()
    assert evt["type"] == "progress"
    assert evt["data"]["prompt_id"] == "p"


@pytest.mark.anyio
async def test_a_child_finishing_alone_emits_no_executed(_db, panel):
    with db.get_session() as session:
        session.add(db.Job(id="p", workflow_json="{}", status="running", origin="panel", user_id="u1", split_count=2))
        session.add(db.Job(id="c0", workflow_json="{}", status="done", origin="panel", user_id="u1", parent_id="p", split_index=0, result_files=json.dumps(["a.png"])))
        session.commit()
        child = session.get(db.Job, "c0")

    await panelws.job_done(child)

    evt = await panel.next_event()
    assert evt["type"] == "status"  # 只有佇列刷新，沒有 executed
```

> `panel` fixture / `panel.next_event()` 沿用 `test_comfy_panel_ws.py` 既有那組。

- [ ] **Step 6: `split_batches` 進設定 API（Python）**

`server/comfyfed_server/auth.py:403-411` 的 `SettingsBody` 加一行：

```python
    split_batches: Optional[bool] = None
```

`_current_settings`（第 417-428 行）的 dict 加一行：

```python
        "split_batches": _get_setting(db_session, split.SPLIT_BATCHES_SETTING_KEY) != "0",
```

`update_settings`（第 480 行的 `object_info_mode` 區塊之後）加入：

```python
    if body.split_batches is not None:
        # Phase 3.3 §3.7：關掉之後不影響已經拆出去的子 job（它們是獨立的
        # queued job），只是新送件的圖不再產生 split_plan。
        updates[split.SPLIT_BATCHES_SETTING_KEY] = "1" if body.split_batches else "0"
```

`auth.py` 檔頭補 `split` 到 `from . import ...`。在 `tests/server/test_auth.py` 加入：

```python
def test_settings_expose_and_update_split_batches(_db, client, csrf, admin_cookie):
    assert client.get("/api/settings", cookies=admin_cookie).json()["split_batches"] is True

    body = client.post(
        "/api/settings", json={"split_batches": False},
        headers={"X-CSRF": csrf}, cookies=admin_cookie,
    ).json()
    assert body["split_batches"] is False

    with db.get_session() as session:
        assert session.get(db.Setting, "split_batches").value == "0"
```

- [ ] **Step 7: 跑整組 Python 測試**

Run: `.venv/Scripts/python.exe -m pytest tests/server tests/agent -q`
Expected: PASS

- [ ] **Step 8: cloud 同步（console / 面板 / 設定）**

1. `cloud/src/routes/jobs.ts` 的 job 序列化（`grep -n "est_vram_gb" cloud/src/routes/jobs.ts` 找到 `jobDict` 之類的 helper）：每列加 `split_count: job.splitCount`、`dispatch_info: job.dispatchInfo`；`GET /api/jobs` 預設加 `parent_id IS NULL` 過濾（`queries.listJobs` 加一個 `opts.includeChildren` 旗標，預設 false 時 SQL 補 `parent_id IS NULL`），並讀 `c.req.query("include_children")`；`GET /api/jobs/:id` 在 `splitCount > 0` 時回 `receipt: null` 加 `children` / `gpu_seconds_total`（用 `split.childrenOf` + `queries.getReceiptsForJob` 逐子 job 加總 billable），否則 `children: []` 與收據自己的 `gpu_seconds`。
2. `cloud/src/routes/comfyapi.ts` 的 `jobOutputs`（`grep -n "subfolder" cloud/src/routes/comfyapi.ts` 定位）：`splitCount > 0` 時改用 `await split.parentOutputs(db, job)` 組檔名與 subfolder；`/queue`、`/history`、`/history/:promptId` 的查詢加 `parent_id IS NULL`（或對單筆加 `job.parentId !== null -> {}`）；`/view` 不動（子 job 的 origin/user_id 承襲父 job），加同一則註解。
3. `cloud/src/do/hub.ts` 的 panel 事件送出點（`panelJobProgress` / `panelJobRunning` / `panelJobRequeued` / `panelJobCancelled` / `panelJobFailed` / `panelJobDone`）：每個開頭先把 job id 換成父 job id（新增一個 private `resolvePanelJobId(jobId)`，語意同 Python 的 `resolve_panel_job_id`）；`panelJobDone(job)` 在 `job.parentId` 存在且父 job 尚未 `done` 時只發 `status` 就 return。佇列長度查詢加 `parent_id IS NULL`。
4. `cloud/src/routes/settings.ts`：`CurrentSettings`（第 32-38 行）加 `split_batches: boolean`；`currentSettings`（第 40-52 行）加 `split_batches: (await getSetting(db, SPLIT_BATCHES_SETTING_KEY)) !== "0"`；`POST` 的 body 型別加 `split_batches?: unknown`，並在 `object_info_mode` 區塊之後加入：

```ts
  if (body.split_batches !== undefined && body.split_batches !== null) {
    if (typeof body.split_batches !== "boolean") {
      return errorJson(
        c,
        400,
        "settings.bad_split_batches",
        "split_batches 必須是 true 或 false。 / split_batches must be a boolean."
      );
    }
    updates[SPLIT_BATCHES_SETTING_KEY] = body.split_batches ? "1" : "0";
  }
```

檔頭補 `import { SPLIT_BATCHES_SETTING_KEY } from "../core/split";`，並更新第 1-8 行那段「這是完整的設定鍵清單」的註解，把 `split_batches` 加進去。

- [ ] **Step 9: 寫 cloud 對應測試**

在 `cloud/test/settings.spec.ts` 加入：

```ts
it("exposes and updates split_batches", async () => {
  const { cookie, csrf } = await adminSession();
  const before = await call("/api/settings", { cookie });
  expect(before.body.split_batches).toBe(true);

  const after = await call("/api/settings", { json: { split_batches: false }, cookie, headers: { "X-CSRF": csrf } });
  expect(after.body.split_batches).toBe(false);

  const bad = await call("/api/settings", { json: { split_batches: "no" }, cookie, headers: { "X-CSRF": csrf } });
  expect(bad.status).toBe(400);
  expect(bad.body.error.code).toBe("settings.bad_split_batches");
});
```

在 `cloud/test/jobs.spec.ts` 加入父 job 的 `children` / `gpu_seconds_total` / `?include_children=1` 三個測試，形狀對照 Step 1 的 Python 版；在 `cloud/test/comfyapi.spec.ts` 加入「父 job 的 `/history` outputs 的 subfolder 是子 job id、順序依 split_index」與「`/queue` 與 `/history` 都看不到子 job」；在 `cloud/test/panel-ws.spec.ts` 加入「子 job 的 progress 事件的 `prompt_id` 是父 job」與「單一子 job 完成不發 executed」。每個檔都沿用它自己既有的 helper。

- [ ] **Step 10: 跑 cloud 測試 + 型別檢查**

Run:
```bash
cd cloud && npm test
cd cloud && npx tsc --noEmit
```
Expected: 全綠

- [ ] **Step 11: Commit**

```bash
git add server/comfyfed_server/jobs.py server/comfyfed_server/comfyapi.py server/comfyfed_server/panelws.py server/comfyfed_server/auth.py tests/server/test_jobs.py tests/server/test_comfyapi.py tests/server/test_comfy_panel_ws.py tests/server/test_auth.py cloud/src/routes/jobs.ts cloud/src/routes/comfyapi.ts cloud/src/routes/settings.ts cloud/src/db/queries.ts cloud/src/do/hub.ts cloud/test/jobs.spec.ts cloud/test/comfyapi.spec.ts cloud/test/panel-ws.spec.ts cloud/test/settings.spec.ts
git commit -F - <<'MSGEOF'
feat(split): surface parents (and hide children) across console, panel, settings

Phase 3.3 Task 7. GET /api/jobs lists parents only (?include_children=1 opts
in) and carries split_count/dispatch_info; GET /api/jobs/:id adds children and
gpu_seconds_total for a parent. The ComfyUI-compat surface sees parents only:
/history, /queue and the panel WS events resolve a child to its parent, and a
parent's outputs are its children's files in split order with the owning child
id as the /view subfolder. split_batches joins the settings API on both stacks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 8: Web UI — 拆分徽章、子 job 表、設定開關

**Files:**
- Modify: `web/src/api.ts:198-241`（`Job` / `JobDetail`）、`:338-355`（`SettingsUpdate` / `SettingsState`）
- Modify: `web/src/pages/Jobs.tsx:632-760`（`JobsTable` 的表頭與列）
- Modify: `web/src/pages/JobDetail.tsx:316-350`（結果那張 Card 之後插入兩張新的）
- Modify: `web/src/pages/Settings.tsx:244-257`（`changeObjectInfoMode` 旁新增 `changeSplitBatches`）與它的渲染區塊
- Modify: `web/src/i18n/zh-TW.json`、`web/src/i18n/en.json`
- Test: `web/src/pages/Jobs.test.tsx`、`web/src/pages/JobDetail.test.tsx`、`web/src/pages/Settings.test.tsx`、`web/src/i18n.test.ts`（既有的鍵對齊測試會自動涵蓋新鍵）

**Interfaces:**
- Consumes: Task 7 的 `GET /api/jobs`（`split_count`、`dispatch_info`）、`GET /api/jobs/{id}`（`children`、`gpu_seconds_total`）、`GET/POST /api/settings`（`split_batches`）。
- Produces: 無後續任務依賴的程式介面；只有 i18n 鍵（`jobs.split_badge`、`job_detail.section_children` 等，見 Step 3）。

- [ ] **Step 1: 寫失敗的 web 測試**

在 `web/src/pages/Jobs.test.tsx` 加入：

```tsx
it('shows a split badge with the child count on a parent job', async () => {
  renderJobs([
    { ...baseJob, id: 'p', status: 'running', progress: 0.5, split_count: 3 },
  ]);
  expect(await screen.findByText('拆分 ×3')).toBeInTheDocument();
});

it('shows no split badge on a plain job', async () => {
  renderJobs([{ ...baseJob, id: 'j1', split_count: 0 }]);
  await screen.findByText('j1');
  expect(screen.queryByText(/拆分 ×/)).not.toBeInTheDocument();
});
```

在 `web/src/pages/JobDetail.test.tsx` 加入：

```tsx
it('lists the children of a split parent with their GPU seconds', async () => {
  renderDetail({
    ...baseDetail,
    id: 'p',
    split_count: 2,
    receipt: null,
    gpu_seconds_total: 30,
    children: [
      { id: 'c0', split_index: 0, status: 'done', worker_id: 'w0', progress: 1, gpu_seconds: 10, error: null },
      { id: 'c1', split_index: 1, status: 'done', worker_id: 'w1', progress: 1, gpu_seconds: 20, error: null },
    ],
  });

  expect(await screen.findByText('子任務')).toBeInTheDocument();
  expect(screen.getByText('c0')).toBeInTheDocument();
  expect(screen.getByText('c1')).toBeInTheDocument();
});

it('shows the dispatch reasoning when dispatch_info is present', async () => {
  renderDetail({
    ...baseDetail,
    dispatch_info: { predicted_seconds: 41.2, basis: 'signature', load_seconds: 0, fetch_seconds: 0, candidates: 3 },
  });

  expect(await screen.findByText('派工依據')).toBeInTheDocument();
  expect(screen.getByText('這台機器跑過同樣的圖')).toBeInTheDocument();
});

it('shows no children card on a plain job', async () => {
  renderDetail({ ...baseDetail, split_count: 0, children: [] });
  await screen.findByText(baseDetail.id);
  expect(screen.queryByText('子任務')).not.toBeInTheDocument();
});
```

在 `web/src/pages/Settings.test.tsx` 加入：

```tsx
it('toggles split_batches and persists it', async () => {
  const user = userEvent.setup();
  renderSettings({ ...baseSettings, split_batches: true });

  const toggle = await screen.findByLabelText('自動拆分批次');
  await user.click(toggle);

  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ split_batches: false }));
});
```

> `renderJobs` / `renderDetail` / `renderSettings` / `baseJob` / `baseDetail` /
> `baseSettings` / `updateSettings` 都沿用各測試檔既有的 helper 與 mock；只要把
> 新欄位補進那些 base 物件。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd web && npm test`
Expected: FAIL（找不到「拆分 ×3」「子任務」「派工依據」「自動拆分批次」）

- [ ] **Step 3: 加 i18n 鍵（zh-TW 先寫，en 同步）**

`web/src/i18n/zh-TW.json` 的 `jobs` 區塊加入：

```json
    "split_badge": "拆分 ×{{count}}",
    "split_badge_tooltip": "這個任務被拆成 {{count}} 份，同時交給多台 worker 跑。"
```

`job_detail` 區塊加入：

```json
    "section_children": "子任務",
    "children_hint": "這個任務被拆成多份同時跑；每一份各自有收據，下面的 GPU 秒數是各自的。",
    "child_index": "序號",
    "child_worker": "Worker",
    "child_status": "狀態",
    "child_progress": "進度",
    "child_gpu_seconds": "GPU 秒數",
    "gpu_seconds_total": "GPU 秒數合計",
    "section_dispatch": "派工依據",
    "dispatch_predicted": "預估執行時間",
    "dispatch_basis": "依據",
    "dispatch_basis_signature": "這台機器跑過同樣的圖",
    "dispatch_basis_speed_index": "別台跑過同樣的圖，依這台的速度換算",
    "dispatch_basis_fleet_default": "還沒跑過這種圖，用整體平均換算",
    "dispatch_basis_none": "還沒有任何歷史資料，用預設值",
    "dispatch_load_seconds": "預估模型載入",
    "dispatch_fetch_seconds": "預估模型下載",
    "dispatch_candidates": "當時合格的 worker 數"
```

`settings` 區塊加入：

```json
    "split_batches": "自動拆分批次",
    "split_batches_hint": "一張 batch_size ≥ 2 的圖，在有多台 worker 閒置時自動拆成多份同時跑。同 seed 同構圖，但不是逐位元一致（差異等同於同一張圖落在不同機器上）。關掉之後新送出的任務一律整包跑在一台上。",
    "split_batches_save_failed": "無法儲存拆分設定"
```

`web/src/i18n/en.json` 同樣的鍵，英文：

```json
    "split_badge": "Split ×{{count}}",
    "split_badge_tooltip": "This job was split into {{count}} parts running on different workers at the same time."
```

```json
    "section_children": "Sub-jobs",
    "children_hint": "This job was split into parts that ran at the same time; each part has its own receipt, and the GPU seconds below are per part.",
    "child_index": "#",
    "child_worker": "Worker",
    "child_status": "Status",
    "child_progress": "Progress",
    "child_gpu_seconds": "GPU seconds",
    "gpu_seconds_total": "Total GPU seconds",
    "section_dispatch": "Why this worker",
    "dispatch_predicted": "Predicted run time",
    "dispatch_basis": "Based on",
    "dispatch_basis_signature": "This worker has run this exact workflow before",
    "dispatch_basis_speed_index": "Another worker has, scaled by this one's speed",
    "dispatch_basis_fleet_default": "Nobody has run this workflow yet; scaled from the fleet average",
    "dispatch_basis_none": "No history at all yet; using the default",
    "dispatch_load_seconds": "Predicted model load",
    "dispatch_fetch_seconds": "Predicted model download",
    "dispatch_candidates": "Eligible workers at the time"
```

```json
    "split_batches": "Split batches automatically",
    "split_batches_hint": "A workflow with batch_size ≥ 2 is split across idle workers and run in parallel. Same seed, same composition — but not bit-for-bit identical (the difference is the same as running one job on a different machine). Turn this off and new jobs always run whole on a single worker.",
    "split_batches_save_failed": "Could not save the split setting"
```

- [ ] **Step 4: 型別**

`web/src/api.ts` 的 `interface Job`（第 198 行）在 `est_vram_gb` 之後加入：

```ts
  /**
   * Phase 3.3 批次拆分：這個任務被拆成幾份（0 = 沒拆，普通任務）。列表預設
   * 只列父／普通任務，所以看到 > 0 就代表這一列底下還有子任務。
   */
  split_count: number;
  /**
   * Phase 3.3 派工依據：claim 當下排程器的選擇理由。空物件代表這個任務還沒
   * 被派出去（或是升級前就存在的舊資料）。
   */
  dispatch_info: DispatchInfo;
```

在 `Job` 之前加入：

```ts
/** `jobs.dispatch_info`：排程器 claim 當下記下的選擇依據（Phase 3.3 §2.2）。 */
export interface DispatchInfo {
  predicted_seconds?: number;
  /** 預估值怎麼來的 -- 決定詳細頁顯示哪一句說明。 */
  basis?: 'signature' | 'speed_index' | 'fleet_default' | 'none' | string;
  load_seconds?: number;
  fetch_seconds?: number;
  candidates?: number;
}

/** 一個拆分任務的子任務摘要（`GET /api/jobs/{id}` 的 `children`）。 */
export interface JobChild {
  id: string;
  split_index: number;
  status: JobStatus | string;
  worker_id: string | null;
  progress: number;
  gpu_seconds: number;
  error: string | null;
}
```

`interface JobDetail`（第 235 行）在 `receipt: JobReceipt | null;` 之後加入：

```ts
  /** 拆分任務的子任務；普通任務永遠是空陣列。 */
  children: JobChild[];
  /** 父任務 = 子任務 billable 收據的加總；普通任務 = 自己收據的 gpu_seconds。 */
  gpu_seconds_total: number;
```

`SettingsUpdate`（第 338 行）與 `SettingsState`（第 348 行）各加 `split_batches?: boolean;` 與 `split_batches: boolean;`。

- [ ] **Step 5: Jobs 列表的徽章**

`web/src/pages/Jobs.tsx:682-701` 是狀態欄與進度欄的 `<Table.Td>`。在狀態欄的 `<Table.Td>` 內容旁（`StatusBadge` 之後）插入：

```tsx
                    {job.split_count > 0 && (
                      <Tooltip label={t('jobs.split_badge_tooltip', { count: job.split_count })}>
                        <Badge size="sm" variant="light" color="grape">
                          {t('jobs.split_badge', { count: job.split_count })}
                        </Badge>
                      </Tooltip>
                    )}
```

（`Badge` / `Tooltip` 若還沒 import，從 `@mantine/core` 補進檔頭的 import。）
進度欄不用改：父 job 的 `progress` 已經是子 job 的平均（Task 6 的 `refresh_parent`）。

- [ ] **Step 6: JobDetail 的子任務表與派工依據**

在 `web/src/pages/JobDetail.tsx` 的收據 Card（第 352 行 `<Card style={cardStyle}>` 那一張）之前插入兩張 Card：

```tsx
          {job.children.length > 0 && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_children')}</Text>
                <Text size="xs" c="dimmed">
                  {t('job_detail.children_hint')}
                </Text>
                <Table.ScrollContainer minWidth={520}>
                  <Table verticalSpacing="xs" horizontalSpacing="md">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('job_detail.child_index')}</Table.Th>
                        <Table.Th>{t('job_detail.child_worker')}</Table.Th>
                        <Table.Th>{t('job_detail.child_status')}</Table.Th>
                        <Table.Th>{t('job_detail.child_progress')}</Table.Th>
                        <Table.Th>{t('job_detail.child_gpu_seconds')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {job.children.map((child) => (
                        <Table.Tr key={child.id}>
                          <Table.Td>
                            <Text size="sm" ff="monospace">
                              {child.id}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {child.split_index + 1} / {job.children.length}
                            </Text>
                          </Table.Td>
                          <Table.Td>{child.worker_id ?? '—'}</Table.Td>
                          <Table.Td>
                            <StatusBadge status={child.status} />
                            {child.error && (
                              <Text size="xs" c="red">
                                {child.error}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>{Math.round(child.progress * 100)}%</Table.Td>
                          <Table.Td>{formatGpuSeconds(child.gpu_seconds)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.gpu_seconds_total')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.gpu_seconds_total)}</Text>
                </Group>
              </Stack>
            </Card>
          )}

          {typeof job.dispatch_info.basis === 'string' && (
            <Card style={cardStyle}>
              <Stack gap="sm">
                <Text fw={600}>{t('job_detail.section_dispatch')}</Text>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_predicted')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.predicted_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_basis')}
                  </Text>
                  <Text size="sm">
                    {t(`job_detail.dispatch_basis_${job.dispatch_info.basis}`, {
                      defaultValue: job.dispatch_info.basis,
                    })}
                  </Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_load_seconds')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.load_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_fetch_seconds')}
                  </Text>
                  <Text size="sm">{formatGpuSeconds(job.dispatch_info.fetch_seconds ?? 0)}</Text>
                </Group>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">
                    {t('job_detail.dispatch_candidates')}
                  </Text>
                  <Text size="sm">{job.dispatch_info.candidates ?? 0}</Text>
                </Group>
              </Stack>
            </Card>
          )}
```

（`Group` / `Table` / `StatusBadge` / `formatGpuSeconds` 若還沒 import，補進檔頭；
`formatGpuSeconds` 已經被收據那張 Card 用了，`StatusBadge` 在 `web/src/components/StatusBadge.tsx`。）

- [ ] **Step 7: Settings 的開關**

`web/src/pages/Settings.tsx` 在 `changeObjectInfoMode`（第 244 行）之後加入：

```tsx
  const changeSplitBatches = async (value: boolean) => {
    const previous = splitBatches;
    setSplitBatches(value);
    setSavingSplitBatches(true);
    try {
      await api.updateSettings({ split_batches: value });
    } catch (caught) {
      setSplitBatches(previous);
      notifyFailure(t('settings.split_batches_save_failed'), caught);
    } finally {
      setSavingSplitBatches(false);
    }
  };
```

在該檔的 state 宣告區加入 `const [splitBatches, setSplitBatches] = useState(true);` 與
`const [savingSplitBatches, setSavingSplitBatches] = useState(false);`，並在載入設定的
`useEffect`（第 89 行 `setObjectInfoMode(...)` 旁）加入 `setSplitBatches(settings.split_batches);`。

在 `object_info_mode` 那張 Card 的同一個區塊裡加入：

```tsx
                <Switch
                  label={t('settings.split_batches')}
                  description={t('settings.split_batches_hint')}
                  checked={splitBatches}
                  disabled={savingSplitBatches}
                  onChange={(event) => changeSplitBatches(event.currentTarget.checked)}
                />
```

（`Switch` 若還沒 import，從 `@mantine/core` 補上。）

- [ ] **Step 8: 跑 web 測試 + 型別檢查**

Run:
```bash
cd web && npm test
cd web && npx tsc --noEmit
```
Expected: 全綠。`i18n.test.ts` 的鍵對齊測試會確認 zh-TW 與 en 兩份的鍵完全一致 —— 掛掉就是有一邊漏了鍵。

- [ ] **Step 9: Commit**

```bash
git add web/src/api.ts web/src/pages/Jobs.tsx web/src/pages/JobDetail.tsx web/src/pages/Settings.tsx web/src/i18n/zh-TW.json web/src/i18n/en.json web/src/pages/Jobs.test.tsx web/src/pages/JobDetail.test.tsx web/src/pages/Settings.test.tsx
git commit -F - <<'MSGEOF'
feat(web): show split badges, sub-job table, dispatch reasoning and the toggle

Phase 3.3 Task 8. The job list badges a split parent with its child count, the
detail page lists the children (worker, status, progress, GPU seconds) plus the
total and explains why the scheduler picked that worker, and Settings gains the
split_batches switch. zh-TW first, en in step.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 9: 文件（SELF-HOSTING zh/en）

**Files:**
- Modify: `docs/SELF-HOSTING.zh.md`（第 190 行「任務分派：輕量工作優先派給弱卡」那一節之後）
- Modify: `docs/SELF-HOSTING.en.md`（第 190 行 "Job dispatch: light jobs go to weak GPUs first" 之後）
- Create: `docs/superpowers/specs/2026-09-15-batch-split-consistency-check.md`（spec §6 最後一條：GPU 才能跑的一致性實測腳本說明）

**Interfaces:**
- Consumes: Task 1-8 的實際行為（寫之前逐項對照程式碼，不要憑記憶寫）。
- Produces: 無程式介面。

- [ ] **Step 1: 寫 zh-TW 章節**

在 `docs/SELF-HOSTING.zh.md` 的 `### 任務分派：輕量工作優先派給弱卡` 那一節之後、`### 安全模型摘要` 之前插入：

```markdown
### 派工與批次拆分

伺服器每 5 秒跑一次派工。從 0.1.x 起，它不再是「一件一件挑最大的卡」，而是把**當下所有在排隊的工作**和**所有閒置的 worker**放進同一張成本表，一次算出整體最省時間的配對（Hungarian 演算法）。成本表裡有這幾項：

- **這台機器跑這種圖要多久**。每張圖送進來時會算一個「工作簽章」（節點組成、模型清單、步數總和、解析度級距、批次大小的雜湊）。同一張圖只改提示詞或 seed，簽章不變；改解析度、步數、模型就會變。每次任務完成、agent 回報了有效的 GPU 執行秒數，平台就把它併進 `(worker, 簽章)` 的指數移動平均。沒跑過這個簽章時，用別台跑過的中位數除以這台的「速度係數」換算；連這個都沒有就用全體平均；全新安裝則假設 60 秒。
- **模型要不要重載**。每台 worker 記著上一次被指派的任務用了哪些模型；這次要用的模型只要已經是熱的就不計成本，冷的就按 1.5 秒/GB 估載入時間。所以「VRAM 小一點但模型已經熱著」常常會贏過「卡比較大但要重載 22 GB」。
- **模型要不要下載**。需要自動下載的候選按 50 MB/s 估時間。原本的規則不變：只要有任何一台 worker 已經有全部模型，要下載的那幾台就完全不列入考慮。
- **輕量工作留大卡**。完全不需要模型的工作（影片剪接那類）仍然優先給弱 GPU／Mac。
- **等越久越優先**。每等 1 秒等於少 1 秒成本；等超過 5 分鐘的工作只要有合格 worker，一定在這一輪派出去。
- **有警告的判定永遠排在乾淨的後面**（例如需要把權重 offload 到系統記憶體）。

任務詳細頁會顯示這一次的判斷依據：預估執行時間、預估是怎麼來的、預估的載入／下載時間、當時有幾台合格的 worker。

#### 自動拆分批次

一張 `batch_size ≥ 2` 的圖，如果當下有多台合格的 worker 閒著，平台會把它拆成多個子任務同時跑，每個子任務負責連續的一段（例如 4 張拆成 2+2）。拆分的做法是在子任務的工作流裡插入一個核心節點 `LatentFromBatch`，指定它只算整批裡的哪幾張——**agent 端不用做任何事，也不用裝任何東西**。

**結果會一樣嗎？** 同 seed、同構圖，但**不是逐位元一致**。ComfyUI 產生批次雜訊時，只要 latent 帶著 `batch_index`（`LatentFromBatch` 會設），就會逐片產生並只保留指定那片，純雜訊層實測是逐位元相同的；端到端跑完之後會有極小的浮點差異（實測 Flux dev 512×512 4 步，平均像素差 0.47/255），來自 batch=2 與 batch=1 的 kernel 路徑不同。**這個差異和「同一張圖交給不同 GPU 跑」本來就有的差異是同一個等級。** 如果你要的是位元級可重現，請關掉拆分。

不是每張圖都能拆。必須全部符合才會拆：

- 圖裡**恰好一個** `EmptyLatentImage` 或 `EmptySD3LatentImage`，而且它的 `batch_size` 是直接填的整數且 ≥ 2。
- 沒有**其他**節點帶 `batch_size` 輸入。
- 圖裡每一個節點都在拆分安全白名單內。**任何自訂節點都不在白名單**，`ImageBatch`、`LatentBatch`、`RepeatLatentBatch`、`RebatchLatents`、影片節點也不在——這些節點會把整批當成一個整體處理，拆了結果就不對了。
- 每一個取樣器吃的 latent 都追得到那個批次來源（中間只能經過會原樣傳遞批次結構的節點）。

其他規則：

- 最多拆成 8 份，而且不會超過當下合格的閒置 worker 數。
- 拆出來的子任務對 ComfyUI 面板是**看不見的**：`/history`、佇列、進度事件看到的都還是原本那一個任務，輸出也是合併後依序排好的，和整批一次跑的順序一致。
- Console（`/jobs`）的任務列表一樣只列原本那一個任務，多一個「拆分 ×k」徽章；詳細頁可以展開看每個子任務落在哪台 worker、跑到哪、用了多少 GPU 秒。
- **收據是一個子任務一張**（父任務沒有收據），所以分潤與用量報表完全不受影響，該記給誰的秒數還是記給誰。
- 任何一個子任務失敗，其他還沒跑完的子任務會一起取消，父任務標成失敗並帶上是第幾份失敗的。取消父任務會取消全部子任務；取消任何一個子任務也會把整組收掉。
- **重試（retry）一律不再拆**：整包在一台 worker 上跑，避免兩代子任務混在一起。

#### 關掉拆分

平台設定頁的「自動拆分批次」開關可以整台關掉（預設開）。關掉之後**新送出**的任務一律整包跑在一台 worker 上；已經拆出去的子任務不受影響，會照常跑完。

只想對某一個任務關掉，就在送件的 `requirements` 裡帶 `{"split": false}`。
```

- [ ] **Step 2: 寫英文章節**

在 `docs/SELF-HOSTING.en.md` 的 `### Job dispatch: light jobs go to weak GPUs first` 之後、`### Security model summary` 之前插入等價的英文章節，標題用：

```markdown
### Scheduling and batch splitting
```
```markdown
#### Automatic batch splitting
```
```markdown
#### Turning splitting off
```

內容逐段對應 Step 1 的 zh-TW 版（同樣的成本項清單、同樣的可拆條件、同樣的一致性說明段落，包含「same seed, same composition, **not bit-for-bit**, the difference is the same order as running the job on a different machine」與「if you need bit-level reproducibility, turn splitting off」這兩句）。不要在英文版省略任何一段——兩份文件的章節結構必須一一對應。

- [ ] **Step 3: 真實性檢查**

逐項比對程式碼，確認文件講的每一句都成立：

```bash
grep -n "LOAD_SEC_PER_GB\|FETCH_BYTES_PER_SEC\|STARVE_SECONDS\|MAX_SPLIT\|DEFAULT_PREDICTED_SECONDS" server/comfyfed_server/scheduler.py server/comfyfed_server/stats.py server/comfyfed_server/split.py
grep -n "SPLIT_SAFE_CLASSES" -A 60 server/comfyfed_server/split.py | head -80
```

確認：1.5 秒/GB、50 MB/s、5 分鐘餓死門檻、最多 8 份、預設 60 秒、白名單確實排除了自訂節點與那四個批次節點。

- [ ] **Step 4: 一致性實測腳本的重跑說明（spec §6 最後一條）**

一致性驗證需要 GPU，不進 CI。在 spec 旁邊放一份說明，讓人半年後還能重跑：建立
`docs/superpowers/specs/2026-09-15-batch-split-consistency-check.md`，內容：

```markdown
# 批次拆分一致性實測：怎麼重跑

`docs/superpowers/specs/2026-09-15-scheduler-and-batch-split-design.md` §3.1 的
數字是 2026-09-15 在本機 ComfyUI 0.34.5 / torch 2.12.1 實測出來的。需要 GPU，
所以不進 CI；要重驗時照下面兩步跑。

## 1. 純雜訊層（應該逐位元相同）

在 ComfyUI 的 Python 環境裡：

```python
import torch
from comfy.sample import prepare_noise

for shape in [(2, 4, 64, 64), (4, 4, 64, 64), (4, 16, 64, 64), (2, 4, 96, 96), (8, 4, 64, 64)]:
    latent = {"samples": torch.zeros(shape)}
    full = prepare_noise(latent["samples"], seed=424242)
    for i in range(shape[0]):
        one = prepare_noise(latent["samples"], seed=424242, noise_inds=[i])
        assert torch.equal(full[i], one[0]), (shape, i)
print("noise layer: bit-identical")
```

## 2. 端到端（應該同構圖、極小浮點差）

用同一個 seed 跑兩次同一張 Flux dev 512×512 4 步的圖：一次 `batch_size=2` 取
第 2 張，一次在 `EmptyLatentImage` 後面接 `LatentFromBatch(batch_index=1,
length=1)` 單獨跑。把兩張 PNG 讀進來比平均絕對差：

```python
import numpy as np
from PIL import Image

a = np.asarray(Image.open("batch2_second.png"), dtype=np.int16)
b = np.asarray(Image.open("latentfrombatch_1.png"), dtype=np.int16)
diff = np.abs(a - b)
print("mean", diff.mean(), "max", diff.max(), "pct>2", (diff > 2).mean() * 100)
```

2026-09-15 的結果：mean 0.47/255、max 22、2.8% 的像素差 > 2；對照組（不同張）
是 17.7/255。只要 mean 落在個位數以內、對照組差一個數量級，結論就成立。
```

- [ ] **Step 5: Commit**

```bash
git add docs/SELF-HOSTING.zh.md docs/SELF-HOSTING.en.md docs/superpowers/specs/2026-09-15-batch-split-consistency-check.md
git commit -F - <<'MSGEOF'
docs: explain the new scheduler and batch splitting in SELF-HOSTING

Phase 3.3 Task 9. Both language versions gain a "scheduling and batch
splitting" section: what goes into the cost model, what makes a workflow
splittable, the consistency claim (same seed and composition, not bit-for-bit,
same order of difference as running on another machine), receipts staying
per-sub-job, and how to turn splitting off globally or per job.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```

---

### Task 10: 端到端（cloud e2e + Python fake-agent）

**Files:**
- Modify: `cloud/test/e2e.spec.ts`（在既有的 `describe("cloud end-to-end", ...)` 裡新增一個 `it`）
- Modify: `tests/server/test_agent_ws.py`（新增等價情境）
- Test: 就是上面兩個檔本身

**Interfaces:**
- Consumes: Task 1-7 的全部行為。不新增任何程式介面。

- [ ] **Step 1: 寫 cloud e2e 情境**

在 `cloud/test/e2e.spec.ts` 的 `describe("cloud end-to-end", ...)` 內、既有兩個 `it` 之後加入。沿用該檔既有的 helper：`call` / `raw` / `db()` / `store()` / `connectAgent` / `connectPanel` / `collectMessages` / `nextMessage` / `expectNoMessage` / `waitFor` / `hub()` / `runDurableObjectAlarm` / `signedCall` / `golden.keypairs`，以及 `deletePendingAlarm` 的 beforeEach/afterEach（已經是 describe 外層的，不用重複）。

```ts
  it(
    "splits a batch_size=4 prompt across two workers, merges the outputs, and honours split_batches=false",
    async () => {
      // ---------------------------------------------------------------
      // 0. Setup + login + panel socket, same opening as the main chain.
      await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
      const loginRes = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
      const cookie = loginRes.setCookie!;
      const csrf = loginRes.body.csrf as string;
      const panel = await connectPanel(cookie);
      await collectMessages(panel, 2); // status + feature_flags

      // ---------------------------------------------------------------
      // 1. 兩台假 worker，都宣告拆分需要的核心節點（含 LatentFromBatch）。
      const nodeClasses = [
        "EmptyLatentImage",
        "KSampler",
        "VAEDecode",
        "SaveImage",
        "CheckpointLoaderSimple",
        "CLIPTextEncode",
        "LatentFromBatch",
      ];
      const agents: { workerId: string; seedHex: string; ws: WebSocket }[] = [];
      for (let i = 0; i < 2; i++) {
        const tokenRes = await call("/api/workers/tokens", {
          json: { name: `gpu-split-${i}` },
          cookie,
          headers: { "X-CSRF": csrf },
        });
        const kp = golden.keypairs[i]!;
        const registerRes = await call("/api/agent/register", {
          json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex },
        });
        const workerId = registerRes.body.worker_id as string;
        const ws = await connectAgent(workerId, kp.seed_hex);
        const helloNone = expectNoMessage(ws, 300);
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol: 2,
            backend: "cuda",
            torch_version: "2.4.0",
            platform: "Linux",
            hardware: { vram_gb: 24, gpu_name: "RTX4090" },
            node_classes: nodeClasses,
          })
        );
        await helloNone;
        await waitFor(
          async () => {
            const row = await db().prepare("SELECT protocol FROM workers WHERE id = ?").bind(workerId).first<any>();
            return row && row.protocol === 2 ? row : undefined;
          },
          { label: `worker ${i} reflects hello` }
        );
        agents.push({ workerId, seedHex: kp.seed_hex, ws });
      }

      // ---------------------------------------------------------------
      // 2. 送一張 batch_size=4、零模型的可拆圖。
      const workflow = {
        "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
        "2": { class_type: "KSampler", inputs: { latent_image: ["1", 0], steps: 4, seed: 424242 } },
        "3": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
        "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
      };
      const promptRes = await call("/comfy/api/prompt", { json: { prompt: workflow }, cookie });
      expect(promptRes.status).toBe(200);
      const parentId = promptRes.body.prompt_id as string;

      const parentRow = await db().prepare("SELECT split_plan FROM jobs WHERE id = ?").bind(parentId).first<any>();
      expect(JSON.parse(parentRow.split_plan)).toEqual({ source_node_id: "1", batch_size: 4 });

      // ---------------------------------------------------------------
      // 3. 一次 tick：拆成 2 個子 job，各派給一台 worker。
      const push0 = nextMessage(agents[0]!.ws);
      const push1 = nextMessage(agents[1]!.ws);
      expect(await runDurableObjectAlarm(hub())).toBe(true);
      const pushed = [await push0, await push1];
      expect(pushed.every((p) => p.type === "job")).toBe(true);

      const children = await db()
        .prepare("SELECT id, split_index, worker_id, workflow_json FROM jobs WHERE parent_id = ? ORDER BY split_index ASC")
        .all<any>();
      expect(children.results).toHaveLength(2);
      expect(new Set(children.results.map((c) => c.worker_id))).toEqual(new Set(agents.map((a) => a.workerId)));
      // 每個子 job 各負責 2 張，範圍連續。
      expect(JSON.parse(children.results[0]!.workflow_json)["cfsplit"].inputs).toEqual({
        samples: ["1", 0],
        batch_index: 0,
        length: 2,
      });
      expect(JSON.parse(children.results[1]!.workflow_json)["cfsplit"].inputs).toEqual({
        samples: ["1", 0],
        batch_index: 2,
        length: 2,
      });

      const parentAfterDispatch = await getJobById(db(), parentId);
      expect(parentAfterDispatch!.status).toBe("assigned");
      expect(parentAfterDispatch!.workerId).toBeNull();

      // 面板的 history 這時只看得到父 job（子 job 完全不可見）。
      const historyMid = await call("/comfy/api/history", { cookie });
      expect(Object.keys(historyMid.body)).not.toContain(children.results[0]!.id);

      // ---------------------------------------------------------------
      // 4. 兩個子 job 各上傳兩張圖並回報完成。
      const pushedByWorker = new Map(
        pushed.map((p, i) => [(p as any).job_id as string, agents[i]!])
      );
      for (const child of children.results) {
        const agent = agents.find((a) => a.workerId === child.worker_id)!;
        const names = [`${child.split_index}_a.png`, `${child.split_index}_b.png`];
        for (const name of names) {
          const form = new FormData();
          form.set("file", new File([new TextEncoder().encode(name)], name));
          const res = await signedCall(
            agent.workerId,
            agent.seedHex,
            "POST",
            `/api/agent/jobs/${child.id}/artifacts`,
            new Uint8Array(),
            {}
          );
          // 若該 helper 不支援 multipart，改用該檔既有的 artifact 上傳樣板
          // （主 e2e 鏈第 10 步就有一份），照抄即可。
          expect([200, 400]).toContain(res.status);
        }
        agent.ws.send(
          JSON.stringify({ type: "job_done", job_id: child.id, result_files: names, exec_seconds: 12.5 })
        );
      }

      await waitFor(
        async () => {
          const parent = await getJobById(db(), parentId);
          return parent && parent.status === "done" ? parent : undefined;
        },
        { label: "parent reaches done once both children finish" }
      );

      // ---------------------------------------------------------------
      // 5. 父 job 依序拿到 4 個輸出，subfolder 是持有檔案的子 job。
      const history = await call(`/comfy/api/history/${parentId}`, { cookie });
      const outputs = history.body[parentId].outputs;
      const images = Object.values(outputs).flatMap((o: any) => o.images ?? []);
      expect(images.map((i: any) => i.filename)).toEqual(["0_a.png", "0_b.png", "1_a.png", "1_b.png"]);
      expect(images[0].subfolder).toBe(children.results[0]!.id);
      expect(images[3].subfolder).toBe(children.results[1]!.id);

      // 面板的 history 仍然只有父 job。
      const historyAll = await call("/comfy/api/history", { cookie });
      expect(Object.keys(historyAll.body)).toEqual([parentId]);

      // ---------------------------------------------------------------
      // 6. 收據兩張（一個子 job 一張），父 job 沒有收據。
      for (const child of children.results) {
        const receipts = await getReceiptsForJob(db(), child.id);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]!.kind).toBe("completed");
      }
      expect(await getReceiptsForJob(db(), parentId)).toHaveLength(0);

      // console 的父 job 詳細頁。
      const detail = await call(`/api/jobs/${parentId}`, { cookie });
      expect(detail.body.receipt).toBeNull();
      expect(detail.body.split_count).toBe(2);
      expect(detail.body.children.map((c: any) => c.split_index)).toEqual([0, 1]);
      expect(detail.body.gpu_seconds_total).toBeGreaterThan(0);

      // ---------------------------------------------------------------
      // 7. split_batches=false 之後，同一張圖不再被拆。
      await call("/api/settings", { json: { split_batches: false }, cookie, headers: { "X-CSRF": csrf } });
      const promptRes2 = await call("/comfy/api/prompt", { json: { prompt: workflow }, cookie });
      const parent2 = promptRes2.body.prompt_id as string;
      const row2 = await db().prepare("SELECT split_plan FROM jobs WHERE id = ?").bind(parent2).first<any>();
      expect(row2.split_plan).toBeNull();

      await runDurableObjectAlarm(hub());
      const children2 = await db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE parent_id = ?").bind(parent2).first<any>();
      expect(children2.n).toBe(0);
      const parent2Row = await getJobById(db(), parent2);
      expect(parent2Row!.splitCount).toBe(0);
      expect(parent2Row!.workerId).not.toBeNull(); // 整包派給單一 worker
    },
    30_000
  );
```

- [ ] **Step 2: 跑 cloud e2e**

Run: `cd cloud && npm test -- e2e`
Expected: PASS。若 artifact 上傳那一段的 helper 對不上，照主 e2e 鏈第 10 步的上傳樣板改寫（那一段已經證明可用）。

- [ ] **Step 3: 寫 Python 等價情境**

在 `tests/server/test_agent_ws.py` 檔尾加入（沿用該檔既有的 fake-agent fixture、`dispatch_tick` 驅動方式與 artifact 上傳 helper；下面用 `_connect_agent` / `_post_prompt` / `_upload_artifact` / `_drain` 這些名稱示意，實作時換成該檔真正的名字）：

```python
@pytest.mark.anyio
async def test_batch_split_end_to_end(_db, _app_client):
    """兩台假 worker、batch_size=4 的圖 -> 2 個子 job 各 2 張、父 job 依序拿到
    4 個輸出、面板 history 只看到父、收據兩張。"""
    agent_a = await _connect_agent("w_a", node_classes=_SPLIT_NODE_CLASSES)
    agent_b = await _connect_agent("w_b", node_classes=_SPLIT_NODE_CLASSES)

    workflow = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 4}},
        "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 4, "seed": 424242}},
        "3": {"class_type": "VAEDecode", "inputs": {"samples": ["2", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
    }
    parent_id = await _post_prompt(_app_client, workflow)

    with db.get_session() as session:
        assert json.loads(session.get(db.Job, parent_id).split_plan) == {
            "source_node_id": "1", "batch_size": 4
        }

    await agentws.dispatch_tick()

    with db.get_session() as session:
        children = (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )
        parent = session.get(db.Job, parent_id)
    assert [c.split_index for c in children] == [0, 1]
    assert {c.worker_id for c in children} == {"w_a", "w_b"}
    assert parent.status == "assigned"
    assert parent.worker_id is None
    assert json.loads(children[0].workflow_json)["cfsplit"]["inputs"] == {
        "samples": ["1", 0], "batch_index": 0, "length": 2
    }
    assert json.loads(children[1].workflow_json)["cfsplit"]["inputs"] == {
        "samples": ["1", 0], "batch_index": 2, "length": 2
    }

    for child in children:
        agent = agent_a if child.worker_id == "w_a" else agent_b
        names = [f"{child.split_index}_a.png", f"{child.split_index}_b.png"]
        for name in names:
            await _upload_artifact(agent, child.id, name)
        await agent.send(
            {"type": "job_done", "job_id": child.id, "result_files": names, "exec_seconds": 12.5}
        )
        await _drain(agent)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        receipts = session.query(db.Receipt).filter(db.Receipt.job_id.in_([c.id for c in children])).all()
        parent_receipts = session.query(db.Receipt).filter(db.Receipt.job_id == parent_id).all()
    assert parent.status == "done"
    assert len(receipts) == 2
    assert parent_receipts == []

    history = _app_client.get(f"/comfy/api/history/{parent_id}").json()
    images = [
        image
        for payload in history[parent_id]["outputs"].values()
        for image in payload.get("images", [])
    ]
    assert [i["filename"] for i in images] == ["0_a.png", "0_b.png", "1_a.png", "1_b.png"]
    assert images[0]["subfolder"] == children[0].id
    assert images[3]["subfolder"] == children[1].id

    all_history = _app_client.get("/comfy/api/history").json()
    assert list(all_history.keys()) == [parent_id]


@pytest.mark.anyio
async def test_split_batches_false_keeps_the_job_whole(_db, _app_client):
    with db.get_session() as session:
        session.add(db.Setting(key=split.SPLIT_BATCHES_SETTING_KEY, value="0"))
        session.commit()

    agent_a = await _connect_agent("w_a", node_classes=_SPLIT_NODE_CLASSES)
    await _connect_agent("w_b", node_classes=_SPLIT_NODE_CLASSES)

    workflow = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 4}},
        "2": {"class_type": "KSampler", "inputs": {"latent_image": ["1", 0], "steps": 4, "seed": 424242}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }
    parent_id = await _post_prompt(_app_client, workflow)

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).split_plan is None

    await agentws.dispatch_tick()

    with db.get_session() as session:
        job = session.get(db.Job, parent_id)
        assert session.query(db.Job).filter(db.Job.parent_id == parent_id).count() == 0
    assert job.split_count == 0
    assert job.worker_id is not None  # 整包派給單一 worker
```

並在該檔頂端加：

```python
_SPLIT_NODE_CLASSES = [
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    "LatentFromBatch",
]
```

以及把 `split` 加進該檔的 import。

- [ ] **Step 4: 跑全部測試**

Run:
```bash
.venv/Scripts/python.exe -m pytest tests/server tests/agent -q
cd cloud && npm test
cd cloud && npx tsc --noEmit
cd web && npm test
cd web && npx tsc --noEmit
```
Expected: 全部綠

- [ ] **Step 5: Commit**

```bash
git add cloud/test/e2e.spec.ts tests/server/test_agent_ws.py
git commit -F - <<'MSGEOF'
test: end-to-end batch split across two workers on both stacks

Phase 3.3 Task 10. Two fake workers, one batch_size=4 prompt: two children of
two images each, the parent collecting all four outputs in batch order with the
owning child as the /view subfolder, the panel's history seeing only the parent,
two receipts and none on the parent -- and with split_batches=false the same
prompt stays whole on a single worker.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSGEOF
```
