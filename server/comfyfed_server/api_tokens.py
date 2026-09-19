"""API token（長效 bearer 憑證）的全部邏輯：產生、雜湊、列出、撤銷、解析。

2026-09-19 spec §4：登入的使用者可以產生 30 天有效的 bearer token 交給 AI
（MCP server）驅動平台。token 在 session 能用的每一條 API 上等價於 session，
但**不能管理 token、不能改密碼、不能登出**（§4.3 的例外清單）。

這個模組是 token 邏輯的唯一住所：`auth.py` 只負責把它接到 FastAPI 依賴與
三條 route 上，除了 `resolve_bearer`／`create_token`／`list_tokens`／
`revoke_token` 之外不碰 `db.ApiToken`。cloud 那一棧的孿生實作對著同一份
spec 寫，所以常數與回應欄位都在這裡集中，改一個地方就好。
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional

from . import db

# spec §4.1／§4.2 的固定值。明文 = "cft_" + secrets.token_urlsafe(32)（43 字）
# = 47 字；`prefix` 取前 12 字（"cft_" + 8）供使用者在清單裡辨識。
API_TOKEN_TTL_DAYS = 30
API_TOKEN_MAX_ACTIVE_PER_USER = 10
API_TOKEN_PREFIX = "cft_"
API_TOKEN_TOUCH_SECONDS = 300
API_TOKEN_NAME_MAX = 64

_PREFIX_CHARS = 12
_BEARER_SCHEME = "bearer"


class TooManyTokens(Exception):
    """已經有 `API_TOKEN_MAX_ACTIVE_PER_USER` 枚有效 token。"""


class BadName(Exception):
    """名稱超過 `API_TOKEN_NAME_MAX` 字。"""


def generate_plaintext() -> str:
    """新的明文 token。只會回傳給使用者一次，伺服器不留。"""
    return API_TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(plaintext: str) -> str:
    """明文的 sha256 hex —— 資料庫裡存的就是這個。

    刻意不用 password hash（bcrypt 之類）：token 是 256 bit 的隨機值，沒有
    字典攻擊面，而每一個 bearer 請求都要查一次，慢雜湊只會讓 API 變慢。
    """
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def is_active(row: db.ApiToken, now: datetime) -> bool:
    """未撤銷且未過期。epoch／使用者狀態不在這裡看 —— 那是 `resolve_bearer`
    的事，清單只回報這一列自身的狀態。"""
    return row.revoked_at is None and row.expires_at > now


def token_dict(row: db.ApiToken, now: datetime) -> dict:
    """spec §4.2 的清單形狀。**永遠不含明文**。"""
    return {
        "id": row.id,
        "name": row.name,
        "prefix": row.prefix,
        "created_at": _isoformat(row.created_at),
        "expires_at": _isoformat(row.expires_at),
        "last_used_at": _isoformat(row.last_used_at),
        "revoked_at": _isoformat(row.revoked_at),
        "active": is_active(row, now),
    }


def _active_query(session, user_id: str, now: datetime):
    return (
        session.query(db.ApiToken)
        .filter(db.ApiToken.user_id == user_id)
        .filter(db.ApiToken.revoked_at.is_(None))
        .filter(db.ApiToken.expires_at > now)
    )


def create_token(
    session, user: db.User, name: str, now: datetime
) -> tuple[db.ApiToken, str]:
    """建一枚 token，回傳 (列, 明文)。呼叫端負責把明文放進那一次的回應。

    Raises `BadName`（名稱過長）／`TooManyTokens`（有效 token 已達上限）。
    上限只數「有效」的：撤銷或過期的列留著當歷史，不佔額度。
    """
    name = name or ""
    if len(name) > API_TOKEN_NAME_MAX:
        raise BadName(name)

    if _active_query(session, user.id, now).count() >= API_TOKEN_MAX_ACTIVE_PER_USER:
        raise TooManyTokens()

    plaintext = generate_plaintext()
    row = db.ApiToken(
        user_id=user.id,
        name=name,
        token_hash=hash_token(plaintext),
        prefix=plaintext[:_PREFIX_CHARS],
        epoch=user.session_epoch,
        created_at=now,
        expires_at=now + timedelta(days=API_TOKEN_TTL_DAYS),
    )
    session.add(row)
    session.commit()
    return row, plaintext


def list_tokens(session, user_id: str, now: datetime) -> list[dict]:
    """這個使用者的全部 token（含已撤銷／已過期），新的在前。"""
    rows = (
        session.query(db.ApiToken)
        .filter(db.ApiToken.user_id == user_id)
        .order_by(db.ApiToken.created_at.desc())
        .all()
    )
    return [token_dict(row, now) for row in rows]


def revoke_token(session, user_id: str, token_id: str, now: datetime) -> bool:
    """撤銷自己的一枚 token。`False` = 不存在或不是自己的（呼叫端答 404）。

    已撤銷的列再撤一次是 idempotent 的成功（不覆寫原本的 `revoked_at`）。
    """
    row = session.get(db.ApiToken, token_id)
    if row is None or row.user_id != user_id:
        return False
    if row.revoked_at is None:
        row.revoked_at = now
        session.commit()
    return True


def _plaintext_from_header(header_value: Optional[str]) -> Optional[str]:
    """`Authorization: Bearer cft_...` -> 明文；格式不對一律 `None`。"""
    if not header_value:
        return None
    parts = header_value.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != _BEARER_SCHEME:
        return None
    plaintext = parts[1].strip()
    if not plaintext.startswith(API_TOKEN_PREFIX):
        return None
    return plaintext


def _touch(session, row: db.ApiToken, now: datetime) -> None:
    """`last_used_at` 最多每 `API_TOKEN_TOUCH_SECONDS` 秒寫回一次。"""
    if (
        row.last_used_at is None
        or (now - row.last_used_at).total_seconds() >= API_TOKEN_TOUCH_SECONDS
    ):
        row.last_used_at = now
        session.commit()


def resolve_bearer_token(
    session, header_value: Optional[str], now: datetime
) -> Optional[tuple[db.ApiToken, db.User]]:
    """`resolve_bearer` 的完整版，多回 token 列本身。

    `/api/auth/me` 要回報 `token_expires_at`，那是列上的欄位而不是使用者
    的；除此之外兩者一模一樣，所以驗證邏輯只有這一份。
    """
    plaintext = _plaintext_from_header(header_value)
    if plaintext is None:
        return None

    row = (
        session.query(db.ApiToken)
        .filter(db.ApiToken.token_hash == hash_token(plaintext))
        .one_or_none()
    )
    if row is None or not is_active(row, now):
        return None

    user = session.get(db.User, row.user_id)
    if user is None or user.disabled:
        return None
    # 與 cookie 同一條規則：改密碼／停用／重設密碼會把 session_epoch 往上
    # 加，發出去的 token 立刻全部失效（spec §9）。
    if row.epoch != user.session_epoch:
        return None

    _touch(session, row, now)
    return row, user


def resolve_bearer(
    session, header_value: Optional[str], now: datetime
) -> Optional[db.User]:
    """header -> 使用者，全部檢查（格式、hash、撤銷、過期、epoch、停用）。

    任何一項不過都回 `None`，呼叫端一律答同一個 401，不區分原因 ——
    「這枚 token 過期了」與「這枚 token 不存在」對沒有 token 的人來說都不
    該是可以問出來的資訊。
    """
    resolved = resolve_bearer_token(session, header_value, now)
    return resolved[1] if resolved is not None else None
