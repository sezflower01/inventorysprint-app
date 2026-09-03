-- Let the seller-detections view exclude the re-baselining backlog.
--
-- ── WHY A BOUNDARY IS NEEDED ──────────────────────────────────────────────
--
-- detected_at records when THIS APP first saw an ASIN in a seller's catalogue,
-- never when the seller began offering it. Detection diffs a seller's current
-- list against a baseline we hold, so a stale or absent baseline reports
-- long-standing listings as new.
--
-- check-seller-watchlist was dead 2026-08-22 to 2026-09-01. On resuming, every
-- baseline was at least ten days old and some were gone entirely -- the first
-- repaired run caught sellers reporting 71,925 and 16,878 "new" ASINs, whole
-- storefronts rather than additions. Those above 500 are skipped and re-seeded,
-- but a seller with a few hundred stale ASINs passes that guard and every one
-- is stamped with the re-baselining date.
--
-- Confirmed against Keepa on 2026-09-03: a listing stamped 2026-09-01 had been
-- sold by that seller since May 2026.
--
-- p_since lets the caller ask only for detections made after baselines were
-- rebuilt, where the date does mean what it appears to mean. NULL keeps every
-- row, because nothing here is deleted or hidden -- only filtered by default,
-- and the caller can always ask for all of it.

DROP FUNCTION IF EXISTS public.get_seller_new_listing_activity(integer);

CREATE OR REPLACE FUNCTION public.get_seller_new_listing_activity(
  p_days  integer     DEFAULT 30,
  p_since timestamptz DEFAULT NULL
)
RETURNS TABLE(
  seller_id      text,
  marketplace    text,
  seller_name    text,
  listings_added bigint,
  last_added_at  timestamptz,
  first_added_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT
    l.seller_id,
    l.marketplace,
    MAX(w.seller_name)   AS seller_name,
    COUNT(*)             AS listings_added,
    MAX(l.detected_at)   AS last_added_at,
    MIN(l.detected_at)   AS first_added_at
  FROM public.seller_watch_new_listings l
  LEFT JOIN public.seller_watchlist w
    ON w.seller_id = l.seller_id
   AND w.marketplace = l.marketplace
   AND w.user_id = l.user_id
  WHERE l.user_id = auth.uid()
    AND l.brand_match_state = 'matched'
    AND l.detected_at >= now() - make_interval(days => GREATEST(p_days, 1))
    -- Applied to the ROWS, not to the result, so the counts belong to the same
    -- window the dates do. Filtering afterwards would show a seller its full
    -- backlog count beside a post-boundary date.
    AND (p_since IS NULL OR l.detected_at >= p_since)
  GROUP BY l.seller_id, l.marketplace
  ORDER BY MAX(l.detected_at) DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_new_listing_activity(integer, timestamptz) TO authenticated;

DO $$
DECLARE v_all bigint; v_after bigint;
BEGIN
  SELECT count(*) INTO v_all
    FROM public.seller_watch_new_listings
   WHERE brand_match_state = 'matched' AND detected_at >= now() - interval '30 days';
  SELECT count(*) INTO v_after
    FROM public.seller_watch_new_listings
   WHERE brand_match_state = 'matched' AND detected_at >= timestamptz '2026-09-02 00:00:00+00';
  RAISE NOTICE 'Matched detections in 30 days: %. After the 2026-09-02 boundary: %.', v_all, v_after;
  RAISE NOTICE 'The difference is the re-baselining backlog -- filtered by default, never deleted.';
END $$;
