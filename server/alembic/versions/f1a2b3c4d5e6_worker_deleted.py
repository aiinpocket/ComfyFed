"""workers.deleted (admin soft delete)

Revision ID: f1a2b3c4d5e6
Revises: e1f2a3b4c5d6
Create Date: 2026-09-15 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Soft delete, not a DROP: receipts/jobs reference workers for the
    # billing ledger, so the row has to survive an admin "delete" for every
    # historical report to keep resolving. See `db.Worker.deleted`.
    op.add_column(
        "workers",
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("workers", "deleted")
