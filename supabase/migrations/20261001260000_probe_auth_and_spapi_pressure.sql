-- Superseded, intentionally a no-op.
--
-- This probe referenced sp_api_rate_limit_state.requests_in_window, a column
-- that does not exist: the SP-API gate stores only (user_id, operation,
-- last_called_at) and claims a slot atomically on the timestamp rather than
-- counting requests in a window. The failed statement left this migration
-- unrecorded and therefore replayed ahead of every later one, which blocks the
-- queue -- hence emptying it rather than deleting the file.
--
-- The corrected probe is 20261001270000_probe_spapi_pressure_fixed.sql.

SELECT 1;
