"""add job input_assets

Revision ID: a1b2c3d4e5f6
Revises: fdcf5a609e43
Create Date: 2026-09-12 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'fdcf5a609e43'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "jobs",
        sa.Column("input_assets", sa.String(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("jobs", "input_assets")
