"""Phase 3.4 P2P NAT traversal: workers.peer_lan_url / peer_nat /
peer_reachable / peer_checked_at / remote_ip.

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-09-16
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b3c4d5e6f7a8"
down_revision: Union[str, Sequence[str], None] = "a2b3c4d5e6f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("workers", sa.Column("peer_lan_url", sa.String(), nullable=True))
    op.add_column(
        "workers",
        sa.Column("peer_nat", sa.String(), nullable=False, server_default="lan"),
    )
    op.add_column("workers", sa.Column("peer_reachable", sa.Integer(), nullable=True))
    op.add_column("workers", sa.Column("peer_checked_at", sa.DateTime(), nullable=True))
    op.add_column("workers", sa.Column("remote_ip", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("workers", "remote_ip")
    op.drop_column("workers", "peer_checked_at")
    op.drop_column("workers", "peer_reachable")
    op.drop_column("workers", "peer_nat")
    op.drop_column("workers", "peer_lan_url")
