-- Brand backfill for seller-watch detections, so "not my brand" becomes an
-- answer rather than an absence.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- Measured 2026-08-30: 8,181 detected listings, only 2,020 with a brand
-- recorded, 151 matching a brand already carried. The other 6,161 are not
-- "not mine" -- nobody knows what they are.
--
-- That distinction matters because the next step is DELETING non-matching
-- listings. Deleting on today's data would destroy ~6,000 rows whose brand was
-- simply never looked up, many of which probably are brands the user carries,
-- and seller-watch detections cannot be re-fetched. So the brand is filled in
-- first and deletion waits for a real answer.
--
-- Same approach as inventory on 2026-08-30: SP-API getCatalogItem, free, ~78%
-- hit rate, its own rate-limit bucket so the repricer is unaffected.
--
-- brand_checked_at is stamped on every attempt including misses -- without it,
-- "Amazon has no brand for this" is indistinguishable from "not tried yet" and
-- the job re-asks the same blanks forever.

ALTER TABLE public.seller_watch_new_listings
  ADD COLUMN IF NOT EXISTS brand_checked_at timestamptz;

COMMENT ON COLUMN public.seller_watch_new_listings.brand_checked_at IS
  'When the SP-API catalog lookup last ran for this ASIN. Non-null with a null brand means Amazon returned no brand -- a real answer, not a gap.';

CREATE INDEX IF NOT EXISTS idx_swnl_brand_backfill
  ON public.seller_watch_new_listings (user_id)
  WHERE brand_checked_at IS NULL;

-- Rows that already carry a brand need no lookup. Marking them up front keeps
-- the queue to genuine unknowns -- 6,161 rather than 8,181 -- and stops the job
-- spending SP-API calls to confirm what is already known.
UPDATE public.seller_watch_new_listings
SET brand_checked_at = now()
WHERE brand_checked_at IS NULL
  AND brand IS NOT NULL
  AND trim(brand) <> '';

DO $$
DECLARE
  v_left bigint;
  v_asins bigint;
BEGIN
  SELECT count(*), count(DISTINCT asin) INTO v_left, v_asins
  FROM public.seller_watch_new_listings WHERE brand_checked_at IS NULL;
  RAISE NOTICE '% listing(s) / % distinct ASIN(s) awaiting a brand lookup.', v_left, v_asins;
END $$;
