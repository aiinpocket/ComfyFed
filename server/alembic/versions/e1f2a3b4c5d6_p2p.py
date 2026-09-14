"""P2P chunked transfer schema (Phase 3.1): model_hashes.chunk_sha256s,
receipts.bytes + job_id nullable, workers.peer_url

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-09-14 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, Sequence[str], None] = 'd0e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "model_hashes",
        sa.Column("chunk_sha256s", sa.Text(), nullable=True),
    )
    op.add_column(
        "workers",
        sa.Column("peer_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "receipts",
        sa.Column("bytes", sa.Integer(), nullable=True),
    )
    # receipts.job_id was NOT NULL since the initial schema; only
    # `kind == "p2p_upload"` receipts (bandwidth booking, no job involved)
    # need it nullable now. SQLite can't ALTER COLUMN in place, so this
    # goes through batch mode (table rebuild under the hood).
    with op.batch_alter_table("receipts") as batch_op:
        batch_op.alter_column(
            "job_id",
            existing_type=sa.String(),
            nullable=True,
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("receipts") as batch_op:
        batch_op.alter_column(
            "job_id",
            existing_type=sa.String(),
            nullable=False,
        )
    op.drop_column("receipts", "bytes")
    op.drop_column("workers", "peer_url")
    op.drop_column("model_hashes", "chunk_sha256s")
