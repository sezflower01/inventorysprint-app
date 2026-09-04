-- Point the SQL brand-matchers at the effective set.
--
-- Both of these read user_brands directly today, so a shared brand would show
-- in the panel and be ignored by the thing that actually counts matches. The
-- panel and the matcher disagreeing about what "my brand" means is precisely
-- the failure that made the seller catalogue report 666 and list nothing.

SET statement_timeout TO '900s';

-- ---- THE ROLLUP --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_seller_brand_catalog_rollup()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_rows bigint;
BEGIN
  -- Own brands UNION shared, per user. Built as one set rather than by calling
  -- get_effective_brands_for() per user: this runs for every account at once,
  -- and a per-user function call would be a loop over a cross join anyway.
  CREATE TEMP TABLE _ub ON COMMIT DROP AS
  SELECT user_id, lower(btrim(brand)) AS b, COALESCE(match_mode, 'exact') AS mode
  FROM public.user_brands
  WHERE COALESCE(status, '') <> 'ignore' AND btrim(COALESCE(brand, '')) <> ''
  UNION
  SELECT u.user_id, lower(btrim(cb.brand)), cb.match_mode
  FROM (SELECT DISTINCT user_id FROM public.seller_watchlist) u
  CROSS JOIN public.catalog_brands cb
  WHERE NOT EXISTS (
          SELECT 1 FROM public.user_catalog_mutes m
           WHERE m.user_id = u.user_id AND m.kind = 'brand' AND m.target_id = cb.id)
    AND NOT EXISTS (
          SELECT 1 FROM public.user_brands ub2
           WHERE ub2.user_id = u.user_id
             AND lower(btrim(ub2.brand)) = lower(btrim(cb.brand)));

  CREATE TEMP TABLE _cached ON COMMIT DROP AS
  SELECT asin, lower(btrim(brand)) AS b
  FROM public.asin_brand_cache
  WHERE brand IS NOT NULL AND btrim(brand) <> '';
  CREATE INDEX ON _cached (b);

  CREATE TEMP TABLE _matched ON COMMIT DROP AS
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode <> 'prefix' AND c.b = u.b
  UNION
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode = 'prefix' AND c.b LIKE u.b || '%';
  CREATE INDEX ON _matched (asin);

  CREATE TEMP TABLE _scope ON COMMIT DROP AS
  SELECT q.seller_id, q.marketplace,
         count(*)                                     AS in_scope,
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

  CREATE TEMP TABLE _pairs ON COMMIT DROP AS
  SELECT DISTINCT w.user_id, w.seller_id, w.marketplace,
         jsonb_array_length(w.known_asin_list) AS catalogue_size
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array';

  TRUNCATE public.seller_brand_catalog_rollup;

  INSERT INTO public.seller_brand_catalog_rollup
    (user_id, seller_id, marketplace, matched_items, identified, catalogue_size, in_scope, last_seen_at)
  SELECT p.user_id, p.seller_id, p.marketplace,
         COALESCE(mc.matched, 0), COALESCE(sc.identified, 0),
         p.catalogue_size, COALESCE(sc.in_scope, 0), ls.last_seen_at
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

-- ---- THE PER-SELLER ITEM LIST ------------------------------------------
CREATE OR REPLACE FUNCTION public.get_seller_brand_items(
  p_seller_id   text,
  p_marketplace text,
  p_since       timestamptz DEFAULT NULL,
  p_limit       integer     DEFAULT 500
)
RETURNS TABLE(
  asin text, title text, brand text, image_url text,
  detected_at timestamptz, still_listed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH allowed AS (
    SELECT w.known_asin_list
    FROM public.seller_watchlist w
    WHERE w.user_id = auth.uid()
      AND w.seller_id = p_seller_id AND w.marketplace = p_marketplace
    ORDER BY jsonb_array_length(
      CASE WHEN jsonb_typeof(w.known_asin_list) = 'array' THEN w.known_asin_list ELSE '[]'::jsonb END
    ) DESC
    LIMIT 1
  ),
  -- Own brands plus the shared catalogue, minus muted. Same definition the
  -- rollup counts with, so the number on the row and the list behind it can
  -- no longer disagree.
  ub AS (
    SELECT lower(btrim(brand)) AS b, match_mode AS mode
    FROM public.get_effective_brands_for(auth.uid())
  ),
  scope AS (
    SELECT q.asin, ab.brand, ab.title
    FROM public.seller_catalog_queue q
    JOIN public.asin_brand_cache ab ON ab.asin = q.asin
    WHERE q.seller_id = p_seller_id AND q.marketplace = p_marketplace
      AND ab.brand IS NOT NULL AND btrim(ab.brand) <> ''
      AND EXISTS (SELECT 1 FROM allowed)
  ),
  mine AS (
    SELECT s.* FROM scope s WHERE EXISTS (
      SELECT 1 FROM ub u
      WHERE (u.mode <> 'prefix' AND lower(btrim(s.brand)) = u.b)
         OR (u.mode  = 'prefix' AND lower(btrim(s.brand)) LIKE u.b || '%')
    )
  )
  SELECT
    m.asin,
    COALESCE(m.title, d.title) AS title,
    m.brand,
    d.image_url,
    d.detected_at,
    COALESCE((SELECT a.known_asin_list @> to_jsonb(m.asin) FROM allowed a), false)
  FROM mine m
  LEFT JOIN LATERAL (
    SELECT (array_agg(l.title     ORDER BY l.detected_at DESC))[1] AS title,
           (array_agg(l.image_url ORDER BY l.detected_at DESC))[1] AS image_url,
           max(l.detected_at) AS detected_at
    FROM public.seller_watch_new_listings l
    WHERE l.asin = m.asin AND l.seller_id = p_seller_id
      AND l.marketplace = p_marketplace AND l.user_id = auth.uid()
  ) d ON true
  WHERE p_since IS NULL OR d.detected_at >= p_since
  ORDER BY d.detected_at DESC NULLS LAST, m.asin
  LIMIT GREATEST(p_limit, 1);
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_brand_items(text, text, timestamptz, integer) TO authenticated;

DO $$
DECLARE t0 timestamptz := clock_timestamp(); v_rows bigint; v_sellers bigint; v_matched bigint;
BEGIN
  SELECT public.refresh_seller_brand_catalog_rollup() INTO v_rows;
  SELECT count(*), COALESCE(sum(matched_items),0) INTO v_sellers, v_matched
    FROM public.seller_brand_catalog_rollup WHERE matched_items > 0;
  RAISE NOTICE 'rollup rebuilt on the effective set in %: % sellers, % matched items',
    clock_timestamp() - t0, v_sellers, v_matched;
END $$;
