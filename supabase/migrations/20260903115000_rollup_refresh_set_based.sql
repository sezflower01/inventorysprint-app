-- Make refresh_seller_brand_catalog_rollup finish.
--
-- The first version timed out. It hung a LATERAL off every (user, seller) pair
-- that re-scanned seller_catalog_queue -- ~1,400 scans of a 345,177-row table
-- -- and nested a second LATERAL inside it that hit
-- seller_watch_new_listings once PER QUEUE ROW. Correct, and quadratic.
--
-- Rewritten as three set-based aggregates, each computed once:
--
--   _scope        per (seller, marketplace)        -- user-independent, so it
--                                                     is computed once rather
--                                                     than once per user
--   _match_counts per (user, seller, marketplace)  -- one pass over the join
--   _lastseen     per (user, seller, marketplace)  -- one grouped scan
--
-- Same numbers, no per-row subqueries.

SET statement_timeout TO '900s';

CREATE OR REPLACE FUNCTION public.refresh_seller_brand_catalog_rollup()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_rows bigint;
BEGIN
  CREATE TEMP TABLE _ub ON COMMIT DROP AS
  SELECT user_id, lower(btrim(brand)) AS b, COALESCE(match_mode, 'exact') AS mode
  FROM public.user_brands
  WHERE COALESCE(status, '') <> 'ignore' AND btrim(COALESCE(brand, '')) <> '';

  CREATE TEMP TABLE _cached ON COMMIT DROP AS
  SELECT asin, lower(btrim(brand)) AS b
  FROM public.asin_brand_cache
  WHERE brand IS NOT NULL AND btrim(brand) <> '';
  CREATE INDEX ON _cached (b);

  -- Exact and prefix split apart: a single ON ... OR ... forces a nested loop
  -- over the whole product instead of letting the exact half use the index.
  CREATE TEMP TABLE _matched ON COMMIT DROP AS
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode <> 'prefix' AND c.b = u.b
  UNION
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode = 'prefix' AND c.b LIKE u.b || '%';
  CREATE INDEX ON _matched (asin);

  -- User-independent: how much of each seller's capped scope we can name a
  -- brand for. This is the denominator the UI shows beside the match count.
  CREATE TEMP TABLE _scope ON COMMIT DROP AS
  SELECT q.seller_id, q.marketplace,
         count(*)                                   AS in_scope,
         count(*) FILTER (WHERE ab.brand IS NOT NULL) AS identified
  FROM public.seller_catalog_queue q
  LEFT JOIN public.asin_brand_cache ab ON ab.asin = q.asin
  GROUP BY q.seller_id, q.marketplace;
  CREATE INDEX ON _scope (seller_id, marketplace);

  CREATE TEMP TABLE _match_counts ON COMMIT DROP AS
  SELECT m.user_id, q.seller_id, q.marketplace, count(DISTINCT q.asin) AS matched
  FROM public.seller_catalog_queue q
  JOIN _matched m ON m.asin = q.asin
  GROUP BY m.user_id, q.seller_id, q.marketplace;
  CREATE INDEX ON _match_counts (user_id, seller_id, marketplace);

  CREATE TEMP TABLE _lastseen ON COMMIT DROP AS
  SELECT user_id, seller_id, marketplace, max(detected_at) AS last_seen_at
  FROM public.seller_watch_new_listings
  GROUP BY user_id, seller_id, marketplace;
  CREATE INDEX ON _lastseen (user_id, seller_id, marketplace);

  -- Every watched pair, so a seller we looked at and found nothing for still
  -- shows a zero rather than vanishing: "none of theirs match" and "we never
  -- looked" must not render identically.
  CREATE TEMP TABLE _pairs ON COMMIT DROP AS
  SELECT DISTINCT w.user_id, w.seller_id, w.marketplace,
         jsonb_array_length(w.known_asin_list) AS catalogue_size
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array';

  TRUNCATE public.seller_brand_catalog_rollup;

  INSERT INTO public.seller_brand_catalog_rollup
    (user_id, seller_id, marketplace, matched_items, identified, catalogue_size, in_scope, last_seen_at)
  SELECT p.user_id, p.seller_id, p.marketplace,
         COALESCE(mc.matched, 0),
         COALESCE(sc.identified, 0),
         p.catalogue_size,
         COALESCE(sc.in_scope, 0),
         ls.last_seen_at
  FROM _pairs p
  LEFT JOIN _scope        sc ON sc.seller_id = p.seller_id AND sc.marketplace = p.marketplace
  LEFT JOIN _match_counts mc ON mc.user_id = p.user_id AND mc.seller_id = p.seller_id
                            AND mc.marketplace = p.marketplace
  LEFT JOIN _lastseen     ls ON ls.user_id = p.user_id AND ls.seller_id = p.seller_id
                            AND ls.marketplace = p.marketplace;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

DO $$
DECLARE t0 timestamptz := clock_timestamp(); v_rows bigint;
BEGIN
  SELECT public.refresh_seller_brand_catalog_rollup() INTO v_rows;
  RAISE NOTICE 'rollup rebuilt: % rows in %', v_rows, clock_timestamp() - t0;
END $$;
