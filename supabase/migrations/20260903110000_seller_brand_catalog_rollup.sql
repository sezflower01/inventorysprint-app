-- Rebuild the Seller catalogue view on real brand data instead of detections.
--
-- Until now get_seller_brand_catalog derived brands from
-- seller_watch_new_listings, so it could only ever see ASINs that happened to
-- be detected as new -- 160 of a 55,330-item catalogue for one seller, zero for
-- five of the ten largest. It now reads asin_brand_cache, which the backfill
-- fills across the capped 345,177-row work set.
--
-- ---- WHY MATERIALISED ---------------------------------------------------
--
-- The live version of this join timed out at the 2-minute statement limit on
-- 2026-09-03: seller_catalog_queue x asin_brand_cache x user_brands is
-- 345,177 x 4,088 in the worst case, and the per-row LATERAL the old
-- seller_new_listings_branded view used was already responsible for two HTTP
-- 500s on plain COUNT queries. A rollup refreshed on a cron turns an
-- unbounded page-load cost into a bounded background one.
--
-- ---- WHY TWO JOINS AND NOT ONE OR ---------------------------------------
--
-- Brand matching is exact OR prefix depending on user_brands.match_mode.
-- Expressing that as a single ON ... OR ... forces a nested loop over the
-- whole product; splitting it lets the exact half use the equality index and
-- confines the LIKE scan to prefix-mode brands only.

CREATE TABLE IF NOT EXISTS public.seller_brand_catalog_rollup (
  user_id        uuid    NOT NULL,
  seller_id      text    NOT NULL,
  marketplace    text    NOT NULL,
  matched_items  bigint  NOT NULL DEFAULT 0,
  identified     bigint  NOT NULL DEFAULT 0,
  catalogue_size integer,
  in_scope       integer NOT NULL DEFAULT 0,
  last_seen_at   timestamptz,
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seller_id, marketplace)
);

ALTER TABLE public.seller_brand_catalog_rollup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own rollup rows" ON public.seller_brand_catalog_rollup;
CREATE POLICY "own rollup rows" ON public.seller_brand_catalog_rollup
  FOR SELECT TO authenticated USING (user_id = auth.uid());

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

  CREATE TEMP TABLE _matched ON COMMIT DROP AS
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode <> 'prefix' AND c.b = u.b
  UNION
  SELECT c.asin, u.user_id FROM _cached c JOIN _ub u ON u.mode = 'prefix' AND c.b LIKE u.b || '%';
  CREATE INDEX ON _matched (asin);

  -- Every (user, seller) pair the user actually watches, so a seller with no
  -- matches still appears with a zero rather than vanishing -- "we looked and
  -- found none" and "we never looked" must not render identically.
  CREATE TEMP TABLE _pairs ON COMMIT DROP AS
  SELECT DISTINCT w.user_id, w.seller_id, w.marketplace,
         jsonb_array_length(w.known_asin_list) AS catalogue_size
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array';

  TRUNCATE public.seller_brand_catalog_rollup;

  INSERT INTO public.seller_brand_catalog_rollup
    (user_id, seller_id, marketplace, matched_items, identified, catalogue_size, in_scope, last_seen_at)
  SELECT
    p.user_id, p.seller_id, p.marketplace,
    COALESCE(s.matched, 0),
    COALESCE(s.identified, 0),
    p.catalogue_size,
    COALESCE(s.in_scope, 0),
    s.last_seen_at
  FROM _pairs p
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE m.asin IS NOT NULL)                       AS matched,
      count(*) FILTER (WHERE ab.brand IS NOT NULL)                     AS identified,
      count(*)                                                         AS in_scope,
      max(l.detected_at)                                               AS last_seen_at
    FROM public.seller_catalog_queue q
    LEFT JOIN public.asin_brand_cache ab ON ab.asin = q.asin
    LEFT JOIN _matched m ON m.asin = q.asin AND m.user_id = p.user_id
    LEFT JOIN LATERAL (
      SELECT max(detected_at) AS detected_at FROM public.seller_watch_new_listings d
       WHERE d.asin = q.asin AND d.seller_id = q.seller_id AND d.marketplace = q.marketplace
    ) l ON true
    WHERE q.seller_id = p.seller_id AND q.marketplace = p.marketplace
  ) s ON true;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_seller_brand_catalog_rollup() FROM public, anon, authenticated;

-- ---- THE VIEW THE UI CALLS ---------------------------------------------
DROP FUNCTION IF EXISTS public.get_seller_brand_catalog();

CREATE OR REPLACE FUNCTION public.get_seller_brand_catalog()
RETURNS TABLE(
  seller_id      text,
  marketplace    text,
  seller_name    text,
  matched_items  bigint,
  catalogue_size integer,
  identified     bigint,
  in_scope       integer,
  refreshed_at   timestamptz,
  last_seen_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT r.seller_id, r.marketplace,
         COALESCE(MAX(w.seller_name), r.seller_id) AS seller_name,
         r.matched_items, r.catalogue_size, r.identified, r.in_scope,
         r.refreshed_at, r.last_seen_at
  FROM public.seller_brand_catalog_rollup r
  LEFT JOIN public.seller_watchlist w
    ON w.seller_id = r.seller_id AND w.marketplace = r.marketplace AND w.user_id = r.user_id
  WHERE r.user_id = auth.uid()
    AND r.matched_items > 0
  GROUP BY r.seller_id, r.marketplace, r.matched_items, r.catalogue_size,
           r.identified, r.in_scope, r.refreshed_at, r.last_seen_at
  ORDER BY r.matched_items DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_seller_brand_catalog() TO authenticated;

-- ---- ITEMS: now from the cache, not only from detections ----------------
DROP FUNCTION IF EXISTS public.get_seller_brand_items(text, text, timestamptz, integer);

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
  WITH ub AS (
    SELECT lower(btrim(brand)) AS b, COALESCE(match_mode,'exact') AS mode
    FROM public.user_brands
    WHERE user_id = auth.uid() AND COALESCE(status,'') <> 'ignore'
      AND btrim(COALESCE(brand,'')) <> ''
  ),
  scope AS (
    SELECT q.asin, ab.brand, ab.title
    FROM public.seller_catalog_queue q
    JOIN public.asin_brand_cache ab ON ab.asin = q.asin
    WHERE q.seller_id = p_seller_id AND q.marketplace = p_marketplace
      AND ab.brand IS NOT NULL AND btrim(ab.brand) <> ''
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
    COALESCE(m.title, d.title)  AS title,
    m.brand,
    d.image_url,
    d.detected_at,
    -- In the queue means in the seller's list as of the last check.
    true AS still_listed
  FROM mine m
  -- Plain aggregates, so this always yields exactly one row (NULLs when we
  -- never detected the ASIN) and the title/image come from the SAME row as
  -- the newest detection. A window function under LIMIT 1 would have taken an
  -- arbitrary row's title beside the newest date.
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
