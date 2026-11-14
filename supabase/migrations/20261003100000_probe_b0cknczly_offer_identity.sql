-- READ-ONLY PROBE, NOW INERT. Kept for the finding, not the query.
--
-- WHAT IT FOUND, which is the part worth keeping: the repricer can count the
-- operator's OWN offer as a competitor. It reported "already lowest among
-- eligible competitors -- holding price (BB owner)" while holding the Buy Box
-- itself, and the line is equally consistent with two readings that are worth
-- very different money:
--
--   * a real rival matching to the cent -> that price IS the market, and
--     raising loses the Buy Box;
--   * our own offer counted as the competitor -> the price has been shadowing
--     itself downwards, and the honest floor is materially higher.
--
-- offers_json names the sellers, so it decides. That is the check to run.
--
-- The same mistake in the browser extension is tracked separately: the offer
-- list must not count the viewing user's own offer as a competitor, which
-- needs a seller id the extension can know without touching cookies.
--
-- ⚠️ THE BODY WAS REMOVED ON 2026-11-14, deliberately, and not because it was
-- wrong. It hardcoded the operator's email address, their seller id, and the
-- per-unit margins and monthly revenue the two readings implied -- in a PUBLIC
-- repository. A diagnostic that has already answered its question is not worth
-- the cost of publishing who ran it and what they earn.
--
-- To re-run it: query the newest repricer_competitor_snapshots row for the
-- ASIN, read offers_json, and count how many offers sit at the held price and
-- how many of those carry your own seller id. Pass your own identifiers in at
-- the SQL Editor rather than committing them. The original text is in this
-- file's git history if the exact query is wanted again.
--
-- This migration now does nothing. It is kept rather than deleted so the
-- applied-migration list stays unbroken.

DO $p$
BEGIN
  RAISE NOTICE 'probe retired -- see the comment at the top of this migration';
END
$p$;
