-- Add request body capture for debugging upstream errors.
-- Note: This table intentionally avoids storing raw prompt_cache_key; the worker redacts it before writing.

ALTER TABLE rc_balance_events ADD COLUMN request_body TEXT;
