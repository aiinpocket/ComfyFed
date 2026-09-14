-- Admin worker deletion, cloud parity of
-- server/alembic/versions/f1a2b3c4d5e6_worker_deleted.py.
--
-- SOFT delete: receipts and jobs reference workers for the billing ledger,
-- so `DELETE /api/workers/:id` flips this flag (plus `disabled`) instead of
-- dropping the row. A deleted worker disappears from `GET /api/workers`,
-- dispatch eligibility and `/metrics`, and the Hub DO refuses its handshake
-- -- while `/api/reports/*` keeps resolving its historical receipts by id.
ALTER TABLE workers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
