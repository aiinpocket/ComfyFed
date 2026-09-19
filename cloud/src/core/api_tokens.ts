/**
 * API token（長效 bearer 憑證）的全部邏輯：產生、雜湊、列出、撤銷、解析。
 * Parity source: `server/comfyfed_server/api_tokens.py`, ported case for case.
 *
 * 2026-09-19 spec §4：登入的使用者可以產生 30 天有效的 bearer token 交給 AI
 * （MCP server）驅動平台。token 在 session 能用的每一條 API 上等價於 session，
 * 但**不能管理 token、不能改密碼、不能登出**（§4.3 的例外清單）。
 *
 * This module is the only home for token logic on the cloud side, exactly as
 * `api_tokens.py` is on the Python side: `lib/guard.ts` only wires
 * `resolveBearerToken` into the four middlewares, and `routes/auth.ts` only
 * turns `createToken`/`listTokens`/`revokeToken` into HTTP. Raw row SQL lives
 * in `db/queries.ts` (this repo's convention), never here.
 *
 * Crypto differences from Python, both forced by the Workers runtime and
 * neither observable in the wire format: `secrets.token_urlsafe(32)` becomes
 * `crypto.getRandomValues` + unpadded base64url (identical alphabet, identical
 * 43-character length for 32 bytes), and `hashlib.sha256` becomes
 * `crypto.subtle.digest("SHA-256")` (identical hex digest).
 */

import { bytesToBase64Url } from "../lib/base64";
import { bytesToHex } from "../lib/hex";
import {
  countActiveApiTokens,
  getApiTokenByHash,
  getApiTokenById,
  insertApiToken,
  listApiTokensForUser,
  revokeApiTokenRow,
  sqliteTimestampToIsoformat,
  toSqliteTimestamp,
  touchApiToken,
  getUserById,
  type ApiToken,
  type User,
} from "../db/queries";

// spec §4.1／§4.2 的固定值。明文 = "cft_" + 32 bytes base64url（43 字）
// = 47 字；`prefix` 取前 12 字（"cft_" + 8）供使用者在清單裡辨識。
export const API_TOKEN_TTL_DAYS = 30;
export const API_TOKEN_MAX_ACTIVE_PER_USER = 10;
export const API_TOKEN_PREFIX = "cft_";
export const API_TOKEN_TOUCH_SECONDS = 300;
export const API_TOKEN_NAME_MAX = 64;

const PREFIX_CHARS = 12;
const BEARER_SCHEME = "bearer";
const TOKEN_BYTES = 32;

/** 已經有 `API_TOKEN_MAX_ACTIVE_PER_USER` 枚有效 token。 */
export class TooManyTokens extends Error {}

/** 名稱超過 `API_TOKEN_NAME_MAX` 字。 */
export class BadName extends Error {}

/** 新的明文 token。只會回傳給使用者一次，伺服器不留。 */
export function generatePlaintext(): string {
  return API_TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** 明文的 sha256 hex —— 資料庫裡存的就是這個。
 *
 * 刻意不用 password hash（PBKDF2 之類）：token 是 256 bit 的隨機值，沒有字典
 * 攻擊面，而每一個 bearer 請求都要查一次，慢雜湊只會讓 API 變慢。 */
export async function hashToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return bytesToHex(new Uint8Array(digest));
}

/** 未撤銷且未過期。epoch／使用者狀態不在這裡看 —— 那是 `resolveBearerToken`
 * 的事，清單只回報這一列自身的狀態。 */
export function isActive(row: ApiToken, now: Date): boolean {
  return row.revokedAt === null && row.expiresAt > toSqliteTimestamp(now);
}

function isoOrNull(value: string | null): string | null {
  return value === null ? null : sqliteTimestampToIsoformat(value);
}

/** spec §4.2 的清單形狀。**永遠不含明文**。 */
export function tokenDict(row: ApiToken, now: Date): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: isoOrNull(row.createdAt),
    expires_at: isoOrNull(row.expiresAt),
    last_used_at: isoOrNull(row.lastUsedAt),
    revoked_at: isoOrNull(row.revokedAt),
    active: isActive(row, now),
  };
}

function randomTokenId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** 建一枚 token，回傳 (列, 明文)。呼叫端負責把明文放進那一次的回應。
 *
 * Throws `BadName`（名稱過長）／`TooManyTokens`（有效 token 已達上限）。
 * 上限只數「有效」的：撤銷或過期的列留著當歷史，不佔額度。
 *
 * D1 有沒有交易？沒有 —— 這裡的 count 與 insert 不是原子的，兩個同時抵達的
 * 建立請求理論上可以讓一個使用者拿到第 11 枚 token。兩句 SQL 之間不做任何別
 * 的事（連 `generatePlaintext` 都先算好）把窗口壓到最小；這個競態是驗收時接
 * 受的（上限是防呆不是安全邊界，而且超額的後果只是多一枚該使用者自己的
 * token，隨時可以撤）。 */
export async function createToken(
  db: D1Database,
  user: { id: string; sessionEpoch: number },
  name: string,
  now: Date
): Promise<{ row: ApiToken; plaintext: string }> {
  // M3：trim 在長度檢查「之前」、而且在這裡做，長度規則才只有一份
  // （呼叫端傳原值就好）。
  const trimmed = (name || "").trim();
  if (trimmed.length > API_TOKEN_NAME_MAX) {
    throw new BadName(trimmed);
  }

  const nowText = toSqliteTimestamp(now);
  const plaintext = generatePlaintext();
  const tokenHash = await hashToken(plaintext);

  if ((await countActiveApiTokens(db, user.id, nowText)) >= API_TOKEN_MAX_ACTIVE_PER_USER) {
    throw new TooManyTokens();
  }

  const row: ApiToken = {
    id: randomTokenId(),
    userId: user.id,
    name: trimmed,
    tokenHash,
    prefix: plaintext.slice(0, PREFIX_CHARS),
    epoch: user.sessionEpoch,
    createdAt: nowText,
    expiresAt: toSqliteTimestamp(new Date(now.getTime() + API_TOKEN_TTL_DAYS * 86400 * 1000)),
    lastUsedAt: null,
    revokedAt: null,
  };
  await insertApiToken(db, row);
  return { row, plaintext };
}

/** 這個使用者的全部 token（含已撤銷／已過期），新的在前。 */
export async function listTokens(db: D1Database, userId: string, now: Date): Promise<Record<string, unknown>[]> {
  const rows = await listApiTokensForUser(db, userId);
  return rows.map((row) => tokenDict(row, now));
}

/** 撤銷自己的一枚 token。`false` = 不存在或不是自己的（呼叫端答 404）。
 *
 * 已撤銷的列再撤一次是 idempotent 的成功（不覆寫原本的 `revoked_at`）。 */
export async function revokeToken(db: D1Database, userId: string, tokenId: string, now: Date): Promise<boolean> {
  const row = await getApiTokenById(db, tokenId);
  if (row === null || row.userId !== userId) return false;
  if (row.revokedAt === null) {
    await revokeApiTokenRow(db, tokenId, toSqliteTimestamp(now));
  }
  return true;
}

/** `Authorization: Bearer cft_...` -> 明文；格式不對一律 `null`。 */
function plaintextFromHeader(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  // Python 的 `str.split(None, 1)`：任意空白分隔、前導空白忽略、最多切兩段。
  const trimmedStart = headerValue.replace(/^\s+/, "");
  const match = /^(\S+)\s+([\s\S]*)$/.exec(trimmedStart);
  if (match === null) return null;
  if (match[1]!.toLowerCase() !== BEARER_SCHEME) return null;
  const plaintext = match[2]!.trim();
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null;
  return plaintext;
}

/** `last_used_at` 最多每 `API_TOKEN_TOUCH_SECONDS` 秒寫回一次。 */
async function touch(db: D1Database, row: ApiToken, now: Date): Promise<void> {
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - API_TOKEN_TOUCH_SECONDS * 1000));
  if (row.lastUsedAt === null || row.lastUsedAt <= cutoff) {
    await touchApiToken(db, row.id, toSqliteTimestamp(now));
  }
}

/** `resolveBearer` 的完整版，多回 token 列本身。
 *
 * `/api/auth/me` 要回報 `token_expires_at`，那是列上的欄位而不是使用者的；
 * 除此之外兩者一模一樣，所以驗證邏輯只有這一份。 */
export async function resolveBearerToken(
  db: D1Database,
  headerValue: string | undefined | null,
  now: Date
): Promise<{ row: ApiToken; user: User } | null> {
  const plaintext = plaintextFromHeader(headerValue);
  if (plaintext === null) return null;

  const row = await getApiTokenByHash(db, await hashToken(plaintext));
  if (row === null || !isActive(row, now)) return null;

  const user = await getUserById(db, row.userId);
  if (user === null || user.disabled) return null;
  // 與 cookie 同一條規則：改密碼／停用／重設密碼會把 session_epoch 往上加，
  // 發出去的 token 立刻全部失效（spec §9）。
  if (row.epoch !== user.sessionEpoch) return null;

  await touch(db, row, now);
  return { row, user };
}

/** header -> 使用者，全部檢查（格式、hash、撤銷、過期、epoch、停用）。
 *
 * 任何一項不過都回 `null`，呼叫端一律答同一個 401，不區分原因 ——「這枚
 * token 過期了」與「這枚 token 不存在」對沒有 token 的人來說都不該是可以問
 * 出來的資訊。 */
export async function resolveBearer(
  db: D1Database,
  headerValue: string | undefined | null,
  now: Date
): Promise<User | null> {
  const resolved = await resolveBearerToken(db, headerValue, now);
  return resolved === null ? null : resolved.user;
}
