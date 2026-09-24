-- 2026-09-21 分頁：任務列表（`GET /api/jobs?page=`）與檔案頁
-- （`GET /api/me/artifacts?page=`）的查詢都是「先用 user_id／status 過濾，再
-- 照 created_at 排序、LIMIT/OFFSET」。jobs 到現在只有 0009 的 `parent_id`
-- 索引，這兩條路徑每次都是全表掃＋排序，列一多就慢。
--
-- 兩個複合索引各對一條路徑：
--   (user_id, created_at)  一般使用者看自己的單、檔案頁
--   (status, created_at)   admin 依狀態篩（Dashboard 的 active 查詢也吃得到）
-- 只增不刪，照本專案 D1 migration 的規矩。
CREATE INDEX IF NOT EXISTS ix_jobs_user_created ON jobs (user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_jobs_status_created ON jobs (status, created_at);
