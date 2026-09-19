"""jobs.attempts + jobs.retry_count + worker_task_failures (job retry /
unsuitable workers).

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-09-19
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("jobs") as batch:
        batch.add_column(
            sa.Column("attempts", sa.String(), nullable=False, server_default="{}")
        )
        batch.add_column(
            sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0")
        )

    op.create_table(
        "worker_task_failures",
        sa.Column("worker_id", sa.String(), nullable=False),
        sa.Column("task_key", sa.String(), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.String(), nullable=True),
        sa.Column("last_job_id", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("worker_id", "task_key"),
    )


def downgrade() -> None:
    op.drop_table("worker_task_failures")
    with op.batch_alter_table("jobs") as batch:
        batch.drop_column("retry_count")
        batch.drop_column("attempts")
