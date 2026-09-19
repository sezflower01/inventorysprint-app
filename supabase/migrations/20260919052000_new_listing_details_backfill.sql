-- New-listing feed: fill the blank titles we already hold, and give the
-- backfill a way to stop re-scanning the same rows.
--
-- ---- WHAT IS WRONG ------------------------------------------------------
-- Measured 2026-09-19 (probe 20260919050000): 43,544 of 144,437 rows in
-- seller_watch_new_listings have no image, and 42,176 of those have no title
-- either -- 30% of the feed reads as a bare ASIN. The seller's example
-- (Plush Island, 94 ASINs detected 2026-09-12) is one of many; WÖLF alone has
-- 1,884 blanks going back to 2026-08-19.
--
-- check-seller-watchlist DOES have a backfill, but it takes the 60 NEWEST
-- blank rows each run and orders by detected_at DESC. Detection adds new
-- blanks continuously (231 today), so the window never advances past the
-- newest arrivals and the 43,313 older ones are unreachable -- not slow,
-- unreachable. Rows that genuinely have nothing to find are re-scanned every
-- run forever, because nothing records that they were tried.
--
-- ---- WHAT THIS MIGRATION DOES -------------------------------------------
-- 1. details_checked_at: when the backfill last tried this row. The worker
--    takes never-tried rows first, then the longest-ago-tried, so every row
--    is reached and a hopeless one costs one attempt per cycle, not one per
--    run.
-- 2. Fills 7,858 titles that asin_brand_cache ALREADY holds (written by
--    backfill-catalog-brands from the same SP-API catalogue). Free: one SQL
--    statement, no API call. Images are not in that cache -- it has no image
--    column -- so those still need SP-API, which the worker now does in
--    batches of 20 instead of one ASIN at a time.

ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS details_checked_at timestamptz;

COMMENT ON COLUMN public.seller_watch_new_listings.details_checked_at IS
  'When check-seller-watchlist last tried to fill this row''s title/image. NULL = never tried; the backfill takes NULLs first, then the oldest, so no row starves and a permanently blank ASIN is not re-tried every run.';

-- Partial index: the backfill only ever queries rows that are still missing
-- something, which is 30% of the table today and shrinking.
CREATE INDEX IF NOT EXISTS seller_watch_new_listings_needs_details_idx
  ON public.seller_watch_new_listings (details_checked_at NULLS FIRST, detected_at DESC)
  WHERE image_url IS NULL OR title IS NULL;

-- The free fill. Only where we hold a real title and the row has none.
DO $fill$
DECLARE n bigint;
BEGIN
  WITH filled AS (
    UPDATE public.seller_watch_new_listings l
    SET title = b.title
    FROM public.asin_brand_cache b
    WHERE b.asin = l.asin AND l.title IS NULL AND b.title IS NOT NULL AND length(btrim(b.title)) > 0
    RETURNING 1)
  SELECT count(*) INTO n FROM filled;
  RAISE NOTICE 'titles filled from asin_brand_cache: %', n;

  SELECT count(*) INTO n FROM public.seller_watch_new_listings WHERE title IS NULL;
  RAISE NOTICE 'still without a title: %', n;
  SELECT count(*) INTO n FROM public.seller_watch_new_listings WHERE image_url IS NULL;
  RAISE NOTICE 'still without an image: %', n;
END
$fill$;
