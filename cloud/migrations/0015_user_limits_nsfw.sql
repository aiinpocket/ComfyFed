-- 2026-09-20 每人額度覆寫＋NSFW 權限：cloud parity of
-- server/alembic/versions/e42aaab759cc_user_limits_nsfw.py。
--
-- 三欄全部 nullable、不回填。NULL 的意思是「沿用全案預設」（`max_file_mb` /
-- `quota_gb` 退回 settings 表的 `upload_max_file_mb` / `upload_user_quota_gb`）
-- 或「允許」（`nsfw_allowed` —— 所有 user 預設都看得到 NSFW，只有 admin 明確
-- 設成 0 的才會在送件時經過 core/nsfw_gate.ts）。
--
-- `nsfw_allowed` 存 INTEGER 0/1（D1 沒有 BOOLEAN），rowToUser 轉成
-- boolean | null；額度兩欄的解析與範圍檢查在 lib/limits.ts，這裡只存值。

ALTER TABLE users ADD COLUMN max_file_mb INTEGER;
ALTER TABLE users ADD COLUMN quota_gb REAL;
ALTER TABLE users ADD COLUMN nsfw_allowed INTEGER;
