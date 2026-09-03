-- Brand backfill for watched-seller catalogues: storage + the capped work queue.
--
-- ---- WHY THIS EXISTS ----------------------------------------------------
--
-- seller_watchlist.known_asin_list holds every watched seller's full current
-- ASIN list, but ASINs ONLY -- no brand, no title. So "what does this seller
-- sell that matches my brands" could only ever be answered for ASINs we had
-- happened to detect as new. Measured 2026-09-03: seller AQTA8KNPZ5FJ2 lists
-- 55,330 items and we knew the brand of 160, and five of the ten largest
-- catalogues had brand data for zero.
--
-- getCatalogItem/searchCatalogItems returns summaries[].brand for free, on the
-- catalog_api bucket, which is a different operation from the pricing bucket
-- the repricer uses -- so this does not compete with repricing.
--
-- ---- WHY A 1,000-PER-SELLER CAP ----------------------------------------
--
-- Uncapped this is 1,749,990 distinct ASINs = 1,708,568 lookups = 85,428
-- batched calls = 11.9h at the bucket ceiling. Capped at 1,000 it is 341,617
-- distinct = 316,900 lookups = 15,845 calls = 2.2h, and it costs almost
-- nothing: 1,220 of 1,400 sellers hold under 1,000 items and are untouched.
-- Only 180 sellers are truncated at all.
--
-- ---- HOW THE 1,000 ARE CHOSEN ------------------------------------------
--
-- The ask was "newest 1,000". Keepa's asinList does NOT support that, and the
-- claim was tested rather than assumed: locating 37,266 ASINs we had watched
-- sellers ADD inside their current lists gives a mean normalised position of
-- 0.5065 (median 0.5152, p10 0.081, p90 0.932) -- uniform. Keepa's order is
-- arbitrary, so "the first 1,000" of a 100,000-item catalogue would be a 1%
-- slice mislabelled as newest. (Post-2-Sep detections alone average 0.2334, so
-- very recent additions do skew to the head, but far too weakly to select on.)
--
-- The only true recency data we hold is our own detected_at, so priority is:
--
--   1  we watched this seller add it        -- genuinely newest, by detected_at
--   2  another watched seller carries it too -- weak relevance proxy, free
--   3  md5(asin) fill                        -- deterministic, unbiased sample
--
-- Tier 3 is hashed rather than taken off the head deliberately: the head is
-- arbitrary but not RANDOM, and Keepa's order plausibly correlates with ASIN
-- age, so taking it would bias the sample toward one era of the catalogue. A
-- hash is stable across runs (the cache is reused, results do not churn) and
-- carries no such bias.
--
-- This self-corrects. Every future check that detects a new listing adds a
-- tier-1 row, so a capped seller's window becomes genuinely newest-weighted
-- over the next few rotations instead of staying a fixed arbitrary slice.

SET statement_timeout TO '900s';

-- ---- STORAGE: global, because a brand is a property of the ASIN ----------
CREATE TABLE IF NOT EXISTS public.asin_brand_cache (
  asin          text PRIMARY KEY,
  brand         text,
  title         text,
  product_group text,
  -- NULL means QUEUED, not "no brand". Stamped even on a miss, so an ASIN
  -- Amazon genuinely has no brand for is never re-asked forever -- the same
  -- reasoning as backfill-asin-brands.brand_checked_at.
  checked_at    timestamptz,
  source        text NOT NULL DEFAULT 'spapi',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Drains as work completes, so the pick stays cheap to the very last batch.
CREATE INDEX IF NOT EXISTS asin_brand_cache_pending_idx
  ON public.asin_brand_cache (asin) WHERE checked_at IS NULL;
CREATE INDEX IF NOT EXISTS asin_brand_cache_brand_idx
  ON public.asin_brand_cache (lower(btrim(brand))) WHERE brand IS NOT NULL;

ALTER TABLE public.asin_brand_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated read asin_brand_cache" ON public.asin_brand_cache;
CREATE POLICY "authenticated read asin_brand_cache"
  ON public.asin_brand_cache FOR SELECT TO authenticated USING (true);

-- ---- THE CAPPED WORK SET ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_catalog_queue (
  seller_id   text     NOT NULL,
  marketplace text     NOT NULL,
  asin        text     NOT NULL,
  priority    smallint NOT NULL,
  PRIMARY KEY (seller_id, marketplace, asin)
);
CREATE INDEX IF NOT EXISTS seller_catalog_queue_asin_idx ON public.seller_catalog_queue (asin);
ALTER TABLE public.seller_catalog_queue ENABLE ROW LEVEL SECURITY; -- service role only

-- Round-robin cursor. Without it the worker drains sellers in whatever order
-- the planner likes and the last seller waits for all the others.
CREATE TABLE IF NOT EXISTS public.seller_catalog_backfill_state (
  seller_id      text NOT NULL,
  marketplace    text NOT NULL,
  last_worked_at timestamptz,
  PRIMARY KEY (seller_id, marketplace)
);
ALTER TABLE public.seller_catalog_backfill_state ENABLE ROW LEVEL SECURITY;

-- ---- SEED ---------------------------------------------------------------
DO $$
DECLARE v_cat bigint; v_q bigint; v_p1 bigint; v_p2 bigint; v_p3 bigint; v_new bigint;
BEGIN
  -- One row per (seller, asin). Sellers are deduped to the longest stored list
  -- so two users watching the same seller do not double the work.
  CREATE TEMP TABLE _cat ON COMMIT DROP AS
  SELECT b.seller_id, b.marketplace, a.asin
  FROM (
    SELECT DISTINCT ON (seller_id, marketplace) seller_id, marketplace, known_asin_list
    FROM public.seller_watchlist
    WHERE jsonb_typeof(known_asin_list) = 'array'
    ORDER BY seller_id, marketplace, jsonb_array_length(known_asin_list) DESC
  ) b
  CROSS JOIN LATERAL jsonb_array_elements_text(b.known_asin_list) a(asin);
  SELECT count(*) INTO v_cat FROM _cat;

  CREATE TEMP TABLE _det ON COMMIT DROP AS
  SELECT seller_id, marketplace, asin, max(detected_at) AS detected_at
  FROM public.seller_watch_new_listings
  GROUP BY seller_id, marketplace, asin;
  CREATE INDEX ON _det (seller_id, marketplace, asin);

  CREATE TEMP TABLE _freq ON COMMIT DROP AS
  SELECT asin FROM (SELECT DISTINCT seller_id, asin FROM _cat) d
  GROUP BY asin HAVING count(*) > 1;
  CREATE INDEX ON _freq (asin);

  INSERT INTO public.seller_catalog_queue (seller_id, marketplace, asin, priority)
  SELECT seller_id, marketplace, asin, priority FROM (
    SELECT c.seller_id, c.marketplace, c.asin,
      CASE WHEN d.asin IS NOT NULL THEN 1
           WHEN f.asin IS NOT NULL THEN 2
           ELSE 3 END AS priority,
      row_number() OVER (
        PARTITION BY c.seller_id, c.marketplace
        ORDER BY
          CASE WHEN d.asin IS NOT NULL THEN 1 WHEN f.asin IS NOT NULL THEN 2 ELSE 3 END,
          d.detected_at DESC NULLS LAST,
          md5(c.asin)
      ) AS rn
    FROM _cat c
    LEFT JOIN _det  d ON d.seller_id = c.seller_id AND d.marketplace = c.marketplace AND d.asin = c.asin
    LEFT JOIN _freq f ON f.asin = c.asin
  ) x
  WHERE rn <= 1000
  ON CONFLICT DO NOTHING;

  SELECT count(*), count(*) FILTER (WHERE priority=1), count(*) FILTER (WHERE priority=2),
         count(*) FILTER (WHERE priority=3)
    INTO v_q, v_p1, v_p2, v_p3 FROM public.seller_catalog_queue;

  INSERT INTO public.seller_catalog_backfill_state (seller_id, marketplace)
  SELECT DISTINCT seller_id, marketplace FROM public.seller_catalog_queue
  ON CONFLICT DO NOTHING;

  -- Seed the cache with the work, checked_at NULL = pending. Anything whose
  -- brand we already know is inserted ALREADY CHECKED so it is never re-asked.
  INSERT INTO public.asin_brand_cache (asin, brand, checked_at, source)
  SELECT q.asin, k.brand,
         CASE WHEN k.brand IS NOT NULL THEN now() ELSE NULL END,
         CASE WHEN k.brand IS NOT NULL THEN 'seeded' ELSE 'spapi' END
  FROM (SELECT DISTINCT asin FROM public.seller_catalog_queue) q
  LEFT JOIN LATERAL (
    SELECT btrim(l.brand) AS brand FROM public.seller_watch_new_listings l
     WHERE l.asin = q.asin AND l.brand IS NOT NULL AND btrim(l.brand) <> ''
     LIMIT 1
  ) k ON true
  ON CONFLICT (asin) DO NOTHING;

  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_new FROM public.asin_brand_cache;

  RAISE NOTICE 'catalogue rows=% | queue=% (p1 detected=%, p2 shared=%, p3 sampled=%)',
    v_cat, v_q, v_p1, v_p2, v_p3;
  RAISE NOTICE 'cache seeded. PENDING LOOKUPS = % | at 20/call = % calls',
    v_new, ceil(v_new / 20.0);
END $$;
