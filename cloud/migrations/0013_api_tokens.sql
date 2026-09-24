-- 2026-09-19 API token（spec §4.1）：給 AI／MCP 用的長效 bearer 憑證，cloud
-- parity of server/alembic/versions/e6f7a8b9c0d1_api_tokens.py.
--
-- 明文永不落地：只存 sha256 hex（`token_hash`，UNIQUE —— 每一個 bearer 請求
-- 都是一次等值查詢，唯一約束本身就是那個索引）與前 12 字（`prefix`，供使用者
-- 在清單裡認出是哪一枚）。`epoch` 是建立當下的 `users.session_epoch`：改密碼／
-- 停用／重設密碼會把它往上加，於是該使用者的所有舊 token 一次全部失效 ——
-- 與 session cookie 完全同一套機制（見 lib/guard.ts 的 `sessionUserFromPayload`）。
--
-- 撤銷是軟的（`revoked_at` 打時間戳，列不刪），使用者才看得到「這枚是我什麼
-- 時候撤掉的」。時間欄位一律是 `toSqliteTimestamp` 形狀的字串，同本 schema
-- 其他每一個 DATETIME 欄位（見 db/queries.ts 的檔頭）。

CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    epoch        INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
);

-- 唯一約束已經替 `token_hash` 建了索引，所以這裡只補「列出我的 token」用的
-- `user_id`（名稱與 Alembic 那一側的 `ix_api_tokens_user_id` 對齊）。
CREATE INDEX ix_api_tokens_user_id ON api_tokens (user_id);
