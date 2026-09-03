-- Two SEPARATE questions about a watched seller, deliberately not merged.
--
--   1. get_seller_brand_catalog  -- "what does this seller sell RIGHT NOW that
--      matches my brands?"  No date filter. State, not events.
--   2. get_seller_new_listing_activity(p_days, p_since)  -- "what did they add
--      RECENTLY?"  Date-filtered, and trustworthy only after the re-baseline.
--
-- These were one tab, and conflating them is what made "Seller activity"
-- misleading: a date that answers question 2 was being read as an answer to
-- question 1.
--
-- ---- WHAT WE ACTUALLY HOLD (measured 2026-09-03) -------------------------
--
-- seller_watchlist.known_asin_list IS the seller's full current ASIN list,
-- rewritten from Keepa /seller?storefront=1 on every check. 1,400 of 1,401
-- watches have one; 1,778,439 ASIN slots in total, median 68 per seller, and
-- five sellers pinned at exactly 100,000 -- Keepa's cap, so those catalogues
-- are larger than we can see.
--
-- It holds ASINs and NOTHING ELSE. No brand, no title. keepa_catalog_products,
-- the table that would supply them, has 0 rows -- created and never populated.
-- The only ASIN->brand data in the database is seller_watch_new_listings
-- (47,981 distinct ASINs, 41,161 with a brand), which covers only ASINs that
-- were once detected as new.
--
-- So a brand-filtered catalogue is possible only over that intersection, and
-- the intersection is thin: seller AQTA8KNPZ5FJ2 lists 55,330 ASINs and we
-- know the brand of 160. Five of the ten largest catalogues have brand data
-- for ZERO, because a first check seeds known_asin_list without detecting
-- anything. Closing the gap means one /product call per ASIN at 1 Keepa token
-- each -- 1.78M tokens against a 20/min guard, roughly 62 days of the entire
-- budget. Not affordable, so the function returns the catalogue size and the
-- identified count alongside the match count, and the UI shows all three. A
-- number that says "160 matched, of 2,102 identified in a 55,330 catalogue"
-- is honest; a bare "160" would read as the whole answer.

CREATE OR REPLACE FUNCTION public.get_seller_brand_catalog()
RETURNS TABLE(
  seller_id      text,
  marketplace    text,
  seller_name    text,
  matched_items  bigint,
  catalogue_size integer,
  identified     bigint,
  last_seen_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH mine AS (
    SELECT DISTINCT l.seller_id, l.marketplace, l.user_id, l.asin, l.detected_at
    FROM public.seller_watch_new_listings l
    WHERE l.user_id = auth.uid()
      AND l.brand_match_state = 'matched'
  ),
  seen AS (
    SELECT l.seller_id, l.marketplace, l.user_id, count(DISTINCT l.asin) AS n
    FROM public.seller_watch_new_listings l
    WHERE l.user_id = auth.uid()
      AND l.brand IS NOT NULL AND btrim(l.brand) <> ''
    GROUP BY l.seller_id, l.marketplace, l.user_id
  )
  SELECT
    m.seller_id,
    m.marketplace,
    MAX(w.seller_name)                         AS seller_name,
    COUNT(*)                                   AS matched_items,
    MAX(jsonb_array_length(w.known_asin_list)) AS catalogue_size,
    MAX(COALESCE(s.n, 0))                      AS identified,
    MAX(m.detected_at)                         AS last_seen_at
  FROM mine m
  JOIN public.seller_watchlist w
    ON w.seller_id = m.seller_id
   AND w.marketplace = m.marketplace
   AND w.user_id = m.user_id
  LEFT JOIN seen s
    ON s.seller_id = m.seller_id
   AND s.marketplace = m.marketplace
   AND s.user_id = m.user_id
  WHERE jsonb_typeof(w.known_asin_list) = 'array'
    -- Currently listed, not merely once detected. That is the whole point of a
    -- catalogue view as against a detection log: an item the seller has since
    -- dropped is history, not inventory. Measured 2026-09-03: all 1,517 matched
    -- detections are still listed, so this removes nothing today -- it is here
    -- so the view stays true as sellers drop items.
    AND w.known_asin_list @> to_jsonb(m.asin)
  GROUP BY m.seller_id, m.marketplace
  ORDER BY COUNT(*) DESC;
$fn$;

-- The items behind either view. p_since NULL = the whole catalogue overlap;
-- p_since set = only detections after it. One function, because the row shape
-- is identical and the window is the only difference.
CREATE OR REPLACE FUNCTION public.get_seller_brand_items(
  p_seller_id   text,
  p_marketplace text,
  p_since       timestamptz DEFAULT NULL,
  p_limit       integer     DEFAULT 500
)
RETURNS TABLE(
  asin         text,
  title        text,
  brand        text,
  image_url    text,
  detected_at  timestamptz,
  still_listed boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT DISTINCT ON (l.asin)
    l.asin,
    l.title,
    l.brand,
    l.image_url,
    l.detected_at,
    COALESCE(w.known_asin_list @> to_jsonb(l.asin), false) AS still_listed
  FROM public.seller_watch_new_listings l
  LEFT JOIN public.seller_watchlist w
    ON w.seller_id = l.seller_id
   AND w.marketplace = l.marketplace
   AND w.user_id = l.user_id
   AND jsonb_typeof(w.known_asin_list) = 'array'
  WHERE l.user_id = auth.uid()
    AND l.seller_id = p_seller_id
    AND l.marketplace = p_marketplace
    AND l.brand_match_state = 'matched'
    AND (p_since IS NULL OR l.detected_at >= p_since)
  ORDER BY l.asin, l.detected_at DESC
  LIMIT GREATEST(p_limit, 1);
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_brand_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_seller_brand_items(text, text, timestamptz, integer) TO authenticated;

DO $$
DECLARE v_sellers bigint; v_items bigint;
BEGIN
  SELECT count(DISTINCT seller_id) INTO v_sellers
    FROM public.seller_watch_new_listings WHERE brand_match_state = 'matched';
  SELECT count(*) INTO v_items
    FROM public.seller_watch_new_listings
   WHERE brand_match_state = 'matched'
     AND detected_at >= timestamptz '2026-09-02 00:00:00+00';
  RAISE NOTICE 'Catalogue view covers % sellers. New-since-2-Sep view covers % items.',
    v_sellers, v_items;
END $$;
