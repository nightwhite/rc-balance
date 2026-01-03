-- Add request headers capture for debugging.
-- Note: The worker redacts sensitive headers (Authorization/Cookie/prompt_cache_key, etc.) before writing.

ALTER TABLE rc_balance_events ADD COLUMN request_headers TEXT;
