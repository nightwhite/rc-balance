-- rc-balance (shared D1) schema
--
-- NOTE: This project uses a shared D1 database, so all table names are prefixed
-- with `rc_balance_` to avoid collisions with other projects.

CREATE TABLE IF NOT EXISTS rc_balance_subscription_snapshots (
  account_label TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  total_quota REAL NOT NULL,
  remaining_quota REAL NOT NULL,
  reset_today INTEGER NOT NULL,
  last_reset_at TEXT
);

