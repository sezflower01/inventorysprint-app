-- Seller activity: who is adding listings in my brands, and when.
--
-- Replaces the "Done" tab, which showed source_status IN ('candidates_found',
-- 'sourced','no_candidates') -- statuses only the automated source worker ever
-- wrote. That worker was deleted on 2026-08-19 (20260819220000), and a grep of
-- every edge function and the entire frontend on 2026-09-02 found NOTHING that
-- writes those values any more. The tab was frozen at 6 rows, could never gain
-- a seventh, and was the DEFAULT landing tab -- so the panel opened on six
-- fossils while 1,246 listings waited behind it.
--
-- ── WHY AN RPC AND NOT CLIENT-SIDE AGGREGATION ────────────────────────────
--
-- The obvious shortcut is to group the rows the panel already fetched. Those
-- are capped at PAGE_SIZE (1,000) against 1,246 matched listings, so a seller
-- whose additions fell outside that window would report a count that is quietly
-- wrong -- and a count that is quietly wrong is worse than no count, because
-- nothing about it looks wrong.
--
-- PostgREST cannot GROUP BY without one of these, so it is a function.
--
-- ── SCOPE: MATCHED ONLY ───────────────────────────────────────────────────
--
-- Deliberately the same single rule as the listing view: brand_match_state =
-- 'matched'. Counting every detection would make this a seller-noise ranking --
-- 30,015 of ~41,000 detections are 'not_mine' -- and the seller adding the most
-- irrelevant listings would top the list. The question worth answering is
-- "which watched sellers are moving in MY brands".

CREATE OR REPLACE FUNCTION public.get_seller_new_listing_activity(p_days integer DEFAULT 30)
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
    -- The listing row carries seller_id but never the NAME; that lives on the
    -- watch. Left-joined so a seller whose watch was cancelled still appears
    -- with its id rather than vanishing from its own history.
    MAX(w.seller_name)                       AS seller_name,
    COUNT(*)                                 AS listings_added,
    MAX(l.detected_at)                       AS last_added_at,
    MIN(l.detected_at)                       AS first_added_at
  FROM public.seller_watch_new_listings l
  LEFT JOIN public.seller_watchlist w
    ON w.seller_id = l.seller_id
   AND w.marketplace = l.marketplace
   AND w.user_id = l.user_id
  WHERE l.user_id = auth.uid()
    AND l.brand_match_state = 'matched'
    AND l.detected_at >= now() - make_interval(days => GREATEST(p_days, 1))
  GROUP BY l.seller_id, l.marketplace
  -- Most recently active first: the question is "who is moving NOW", not who
  -- has the largest all-time pile.
  ORDER BY MAX(l.detected_at) DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_new_listing_activity(integer) TO authenticated;

DO $$
DECLARE v_sellers int; v_listings bigint;
BEGIN
  SELECT count(DISTINCT (seller_id, marketplace)), count(*)
    INTO v_sellers, v_listings
    FROM public.seller_watch_new_listings
   WHERE brand_match_state = 'matched'
     AND detected_at >= now() - interval '30 days';
  RAISE NOTICE 'get_seller_new_listing_activity created: % seller(s), % matched listing(s) in 30 days.',
    v_sellers, v_listings;
END $$;
