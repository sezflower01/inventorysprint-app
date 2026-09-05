-- Fix: topup_seller_catalog_queue failed on its first real run.
--
--   column "checked_at" is of type timestamp with time zone
--   but expression is of type text (42804)
--
-- The cache insert selected a bare NULL for checked_at. An untyped NULL in a
-- SELECT list defaults to text, which matches nothing on a timestamptz column.
-- The seed migration never hit this because it used a CASE expression whose
-- other branch was now(), giving Postgres the type.
--
-- It only surfaced because the path was FORCED to run: on install the function
-- reported "0 sellers" -- correct, every seller was already queued -- and would
-- have kept reporting nothing while being incapable of doing the one job it
-- exists for. A top-up that has never topped anything up looks identical to
-- one that has nothing to do.

CREATE OR REPLACE FUNCTION public.topup_seller_catalog_queue(
  p_sellers integer DEFAULT 25,
  p_cap     integer DEFAULT 1000
)
RETURNS TABLE(sellers_processed integer, queue_rows_added bigint, cache_rows_added bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_sellers integer := 0;
  v_queue   bigint  := 0;
  v_cache   bigint  := 0;
  v_added   bigint;
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (w.seller_id, w.marketplace)
           w.seller_id, w.marketplace, w.known_asin_list
    FROM public.seller_watchlist w
    LEFT JOIN public.seller_catalog_backfill_state st
      ON st.seller_id = w.seller_id AND st.marketplace = w.marketplace
    WHERE jsonb_typeof(w.known_asin_list) = 'array'
      AND jsonb_array_length(w.known_asin_list) > 0
      AND (st.queue_synced_at IS NULL
           OR st.queue_synced_at < now() - interval '7 days')
    ORDER BY w.seller_id, w.marketplace,
             jsonb_array_length(w.known_asin_list) DESC
    LIMIT GREATEST(p_sellers, 1)
  LOOP
    v_sellers := v_sellers + 1;

    INSERT INTO public.seller_catalog_queue (seller_id, marketplace, asin, priority)
    SELECT seller_id, marketplace, asin, priority FROM (
      SELECT r.seller_id, r.marketplace, a.asin,
        CASE WHEN d.asin IS NOT NULL THEN 1
             WHEN f.asin IS NOT NULL THEN 2
             ELSE 3 END AS priority,
        row_number() OVER (
          ORDER BY
            CASE WHEN d.asin IS NOT NULL THEN 1 WHEN f.asin IS NOT NULL THEN 2 ELSE 3 END,
            d.detected_at DESC NULLS LAST,
            md5(a.asin)
        ) AS rn
      FROM jsonb_array_elements_text(r.known_asin_list) a(asin)
      LEFT JOIN LATERAL (
        SELECT l.asin, max(l.detected_at) AS detected_at
        FROM public.seller_watch_new_listings l
        WHERE l.asin = a.asin AND l.seller_id = r.seller_id
          AND l.marketplace = r.marketplace
        GROUP BY l.asin
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT q2.asin FROM public.seller_catalog_queue q2
         WHERE q2.asin = a.asin AND q2.seller_id <> r.seller_id LIMIT 1
      ) f ON true
    ) x
    WHERE rn <= GREATEST(p_cap, 1)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_added = ROW_COUNT;
    v_queue := v_queue + v_added;

    -- NULL::timestamptz, not a bare NULL: the column is timestamptz and an
    -- untyped NULL in a SELECT list is text.
    INSERT INTO public.asin_brand_cache (asin, checked_at, source)
    SELECT DISTINCT q.asin, NULL::timestamptz, 'spapi'
    FROM public.seller_catalog_queue q
    WHERE q.seller_id = r.seller_id AND q.marketplace = r.marketplace
    ON CONFLICT (asin) DO NOTHING;

    GET DIAGNOSTICS v_added = ROW_COUNT;
    v_cache := v_cache + v_added;

    INSERT INTO public.seller_catalog_backfill_state
      (seller_id, marketplace, queue_synced_at)
    VALUES (r.seller_id, r.marketplace, now())
    ON CONFLICT (seller_id, marketplace)
      DO UPDATE SET queue_synced_at = now();
  END LOOP;

  sellers_processed := v_sellers;
  queue_rows_added  := v_queue;
  cache_rows_added  := v_cache;
  RETURN NEXT;
END;
$fn$;

REVOKE ALL ON FUNCTION public.topup_seller_catalog_queue(integer, integer) FROM public, anon, authenticated;
