-- Placeholder. This version was applied on 2026-11-02 and ran the first pass of
-- the auto-average test suite: 5 passed, 1 failed. The failure was my own
-- assertion, not the code -- it demanded that no asin_cog_on_record row exist
-- for an override-protected ASIN, but cog_on_record_from_listing (an AFTER
-- INSERT trigger on created_listings) had created one with source='listing'.
--
-- The corrected suite lives in 20261102104000. This file is kept as a no-op so
-- the migration history stays intact; renaming an applied version orphans it
-- and breaks every later push.
DO $p$ BEGIN
  RAISE NOTICE 'no-op: superseded by 20261102104000_cog_auto_average_tests.sql';
END $p$;
