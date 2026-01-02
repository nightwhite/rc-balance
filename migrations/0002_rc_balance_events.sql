CREATE TABLE IF NOT EXISTS rc_balance_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  account_label TEXT,
  route_key_hash TEXT,
  upstream_status INTEGER,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS rc_balance_events_ts_idx ON rc_balance_events (ts);
CREATE INDEX IF NOT EXISTS rc_balance_events_kind_ts_idx ON rc_balance_events (kind, ts);
