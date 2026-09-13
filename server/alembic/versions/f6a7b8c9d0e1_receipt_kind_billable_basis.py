"""receipt kind, billable, basis

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-09-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6a7b8c9d0e1'
down_revision: Union[str, Sequence[str], None] = 'e5f6a7b8c9d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Every existing receipt predates non-billable receipts (Phase 1.9 Task
    # 5) and was minted only on a successful job_done, so "completed" /
    # billable=1 / basis="exec" is the correct backfill, not a placeholder --
    # see agentws._create_and_push_receipt for the pre-existing mint path.
    op.add_column(
        "receipts",
        sa.Column("kind", sa.String(), nullable=False, server_default="completed"),
    )
    op.add_column(
        "receipts",
        sa.Column("billable", sa.Boolean(), nullable=False, server_default="1"),
    )
    op.add_column(
        "receipts",
        sa.Column("basis", sa.String(), nullable=False, server_default="exec"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("receipts", "basis")
    op.drop_column("receipts", "billable")
    op.drop_column("receipts", "kind")
