"""initial schema

Revision ID: fdcf5a609e43
Revises: 
Create Date: 2026-09-12 16:58:03.050949

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'fdcf5a609e43'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "settings",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("value", sa.String(), nullable=False),
    )

    op.create_table(
        "workers",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("pubkey", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="offline"),
        sa.Column("last_seen", sa.DateTime(), nullable=True),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("hardware", sa.String(), nullable=False, server_default="{}"),
        sa.Column("dynamic", sa.String(), nullable=False, server_default="{}"),
        sa.Column("backend", sa.String(), nullable=False, server_default=""),
        sa.Column("torch_version", sa.String(), nullable=False, server_default=""),
        sa.Column("node_classes", sa.String(), nullable=False, server_default="[]"),
        sa.Column("model_inventory", sa.String(), nullable=False, server_default="[]"),
    )

    op.create_table(
        "register_tokens",
        sa.Column("token", sa.String(), primary_key=True),
        sa.Column("worker_name", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("workflow_json", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="queued"),
        sa.Column("worker_id", sa.String(), nullable=True),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("result_files", sa.String(), nullable=False, server_default="[]"),
        sa.Column("requirements", sa.String(), nullable=False, server_default="{}"),
        sa.Column("required_nodes", sa.String(), nullable=False, server_default="[]"),
        sa.Column("required_models", sa.String(), nullable=False, server_default="[]"),
        sa.Column("est_vram_gb", sa.Float(), nullable=True),
    )

    op.create_table(
        "receipts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("job_id", sa.String(), nullable=False),
        sa.Column("worker_id", sa.String(), nullable=False),
        sa.Column("gpu_seconds", sa.Float(), nullable=False),
        sa.Column("platform_sig", sa.String(), nullable=False),
        sa.Column("worker_sig", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )

    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("login_attempts")
    op.drop_table("receipts")
    op.drop_table("jobs")
    op.drop_table("register_tokens")
    op.drop_table("workers")
    op.drop_table("settings")
