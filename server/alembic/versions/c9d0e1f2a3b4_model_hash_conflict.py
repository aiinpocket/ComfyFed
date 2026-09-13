"""model_hashes.conflict flag (persistent, replaces in-memory poisoning)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-09-13 00:00:01.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d0e1f2a3b4'
down_revision: Union[str, Sequence[str], None] = 'b8c9d0e1f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Fix round 1 (Task 7 review, m1 promoted to a real fix): a hash
    # conflict for a (name, size_bytes) key used to be tracked ONLY in
    # model_manifest.py's module-level, per-process `_poisoned_names` set --
    # forgotten on every restart/second-replica, and (on the cloud side)
    # unreachable from anywhere but the one Durable Object that happened to
    # see the conflicting inventory report. Persisting it directly on the
    # `model_hashes` row makes exclusion a plain SQL predicate any process/
    # replica/route can apply on its own, with no coordination needed.
    op.add_column(
        "model_hashes",
        sa.Column("conflict", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("model_hashes", "conflict")
