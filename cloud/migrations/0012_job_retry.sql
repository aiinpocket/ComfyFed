-- 2026-09-19 job-retry：失敗改派＋worker 不適任紀錄（spec §4），cloud parity
-- of server/alembic/versions/d5e6f7a8b9c0_job_retry.py.
--
-- `attempts` 是 `{worker_id: failures}` 的 JSON，DEFAULT '{}' 讓既有每一列
-- （以及每一句沒有指名這個欄位的 INSERT）讀回來就是「還沒失敗過」；
-- `retry_count` 是這張 job 被送回佇列的次數。`worker_task_failures` 的形狀
-- 刻意比照既有的 `worker_job_stats`：複合主鍵、每次事件 upsert 一列。

ALTER TABLE jobs ADD COLUMN attempts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE worker_task_failures (
  worker_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_job_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, task_key)
);
