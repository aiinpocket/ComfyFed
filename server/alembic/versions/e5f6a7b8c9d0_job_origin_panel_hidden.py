"""job origin, panel_hidden

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-09-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Every existing row predates origin scoping and was submitted through
    # the console (the panel-scoped controls this column enables --
    # /comfy/api/interrupt, /comfy/api/queue, panel history -- did not exist
    # yet), so "console" is the correct backfill, not just a placeholder.
    op.add_column(
        "jobs",
        sa.Column("origin", sa.String(), nullable=False, server_default="console"),
    )
    # Soft-delete flag for the panel's own history view; rows are never
    # actually deleted because receipts reference jobs by id.
    op.add_column(
        "jobs",
        sa.Column("panel_hidden", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("jobs", "panel_hidden")
    op.drop_column("jobs", "origin")
