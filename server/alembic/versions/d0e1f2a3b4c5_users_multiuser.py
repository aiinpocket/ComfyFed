"""users table, jobs.user_id, login_attempts.username (Phase 3.0 multi-user)

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-09-14 00:00:00.000000

"""
import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, Sequence[str], None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("username", sa.String(), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("session_epoch", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.add_column("jobs", sa.Column("user_id", sa.Text(), nullable=True))
    op.add_column("login_attempts", sa.Column("username", sa.Text(), nullable=True))

    # Data migration: the single admin account used to live as a hashed
    # password in `settings`. Carry it over as the first `users` row (same
    # hash, so the existing admin password keeps working unchanged), point
    # every pre-existing job at it, and retire the setting -- from here on
    # `auth.py` reads/writes users, not settings, for credentials.
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT value FROM settings WHERE key = 'admin_password_hash'")
    ).fetchone()
    if row is not None:
        admin_hash = row[0]
        admin_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")
        bind.execute(
            sa.text(
                "INSERT INTO users (id, username, password_hash, role, disabled, "
                "session_epoch, created_at) VALUES (:id, 'admin', :hash, 'admin', 0, 0, :now)"
            ),
            {"id": admin_id, "hash": admin_hash, "now": now},
        )
        bind.execute(
            sa.text("UPDATE jobs SET user_id = :id"),
            {"id": admin_id},
        )
        bind.execute(sa.text("DELETE FROM settings WHERE key = 'admin_password_hash'"))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("login_attempts", "username")
    op.drop_column("jobs", "user_id")
    op.drop_table("users")
