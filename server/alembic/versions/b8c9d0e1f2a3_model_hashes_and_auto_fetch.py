"""model hashes and worker auto_fetch

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-09-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8c9d0e1f2a3'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Learned (name, size_bytes) -> sha256 consensus fed by agent inventory
    # reports (Phase 2.1 Task 2) -- see comfyfed_server.model_manifest.
    op.create_table(
        "model_hashes",
        sa.Column("name", sa.String(), primary_key=True),
        sa.Column("size_bytes", sa.Integer(), primary_key=True),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("first_worker_id", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    # Per-pre-flight-ledger ruling: carried in this migration alongside
    # model_hashes so Task 3 (which consumes it) doesn't need its own
    # migration. Every existing worker predates opt-in auto-fetch.
    op.add_column(
        "workers",
        sa.Column("auto_fetch", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("workers", "auto_fetch")
    op.drop_table("model_hashes")
