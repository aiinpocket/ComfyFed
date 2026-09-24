-- 2026-09-24 儲存配額納入 job 位元組：`jobs.artifact_bytes` /
-- `jobs.input_bytes` —— 一張 job 在 R2 上的成品（`artifacts/<job_id>/`）與
-- 輸入資產（`job_inputs/<job_id>/`）各占多少位元組的計數器。
--
-- 配額本來只算 `staging/<uid>/` + `userdata/<uid>/`（lib/limits.ts），job 的
-- 位元組被明文排除；現在要納入，但每次上傳都逐張 job 去 list R2 太慢，所以
-- 改成在寫入／刪除成品與輸入時維護這兩欄，配額算 `SUM` 就好。
--
-- 兩欄皆 nullable、**不回填**：NULL 的意思是「還不知道／尚未回填」（migration
-- 之前就存在的列），0 是「確定是空的」。`GET /api/me/artifacts` 列到一張
-- `artifact_bytes IS NULL` 的單時會順手用 R2 list 的結果補寫（lazy backfill），
-- 所以舊單只要被檔案頁看過一次就會開始計入配額。
--
-- 沒有索引：唯一的讀法是 `SUM(...) WHERE user_id = ?`，0016 的
-- `ix_jobs_user_created` 已經涵蓋這個過濾。

ALTER TABLE jobs ADD COLUMN artifact_bytes INTEGER;
ALTER TABLE jobs ADD COLUMN input_bytes INTEGER;
