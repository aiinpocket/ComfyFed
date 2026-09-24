-- 2026-09-20 檔案頁（spec §2）：`jobs.label` —— 一張 job 的人類可讀名稱，
-- cloud parity of server/alembic/versions/f2a3b4c5d6e7_job_label.py。
--
-- nullable 且**不回填**舊列：名稱是「這次送件叫什麼」，對一張三個月前送出
-- 的單沒有正確答案可補，硬填一個推導值只會在檔案頁上長出一堆語意可疑的
-- 資料夾。NULL 的意思就是「沒有名稱」，console 顯示時退回 job id 前 8 碼。
--
-- 值進欄位前一律經過 `core/label.ts` 的 `normalizeLabel`（去頭尾空白、截到
-- `LABEL_MAX_CHARS` = 64、空字串當 NULL），所以「沒有名稱」在這一欄只有
-- NULL 一種表示法，前端不必分辨 `''` 與 NULL。沒有明確名稱時由
-- `deriveLabel(workflow)` 從第一個 `Save*` 節點的 `filename_prefix` 末段推。
--
-- 沒有索引：檔案頁的查詢（`listDoneJobsWithResultsForUser`）是用 `user_id` +
-- `status` 過濾後才讀這一欄，`label` 本身從不出現在 WHERE 裡。

ALTER TABLE jobs ADD COLUMN label TEXT;
