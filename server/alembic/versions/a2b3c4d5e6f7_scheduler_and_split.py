"""Phase 3.3 scheduler + batch split: job signature/dispatch_info/split
columns, worker speed_index/warm_models, worker_job_stats table.

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-09-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("signature", sa.String(), nullable=True))
    op.add_column(
        "jobs",
        sa.Column("dispatch_info", sa.String(), nullable=False, server_default="{}"),
    )
    op.add_column("jobs", sa.Column("parent_id", sa.String(), nullable=True))
    op.add_column("jobs", sa.Column("split_index", sa.Integer(), nullable=True))
    op.add_column(
        "jobs",
        sa.Column("split_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("jobs", sa.Column("split_plan", sa.String(), nullable=True))

    op.add_column(
        "workers",
        sa.Column("speed_index", sa.Float(), nullable=False, server_default="1.0"),
    )
    op.add_column(
        "workers",
        sa.Column("warm_models", sa.String(), nullable=False, server_default="[]"),
    )

    op.create_table(
        "worker_job_stats",
        sa.Column("worker_id", sa.String(), primary_key=True),
        sa.Column("signature", sa.String(), primary_key=True),
        sa.Column("ewma_seconds", sa.Float(), nullable=False),
        sa.Column("samples", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_worker_job_stats_signature", "worker_job_stats", ["signature"])
    op.create_index("ix_jobs_parent_id", "jobs", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_parent_id", table_name="jobs")
    op.drop_index("ix_worker_job_stats_signature", table_name="worker_job_stats")
    op.drop_table("worker_job_stats")
    op.drop_column("workers", "warm_models")
    op.drop_column("workers", "speed_index")
    op.drop_column("jobs", "split_plan")
    op.drop_column("jobs", "split_count")
    op.drop_column("jobs", "split_index")
    op.drop_column("jobs", "parent_id")
    op.drop_column("jobs", "dispatch_info")
    op.drop_column("jobs", "signature")
