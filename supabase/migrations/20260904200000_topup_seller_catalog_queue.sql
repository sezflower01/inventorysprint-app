-- Keep the catalogue work queue current as sellers are added and change.
--
-- ---- THE GAP -------------------------------------------------------------
--
-- seller_catalog_queue was populated by a one-time seed on 2026-09-03 and
-- nothing has written to it since -- no edge function, no cron. So any seller
-- watched after that date never entered the queue, was never brand-backfilled,
-- and could never appear in the Seller catalogue tab. The feature worked
-- perfectly for the sellers that happened to exist when it was built and
-- silently covered nothing added afterwards.
--
-- Found while checking what a brand-new account would experience: its sellers
-- would all be post-seed, so its Seller catalogue would have been permanently
-- empty with nothing to explain why.
--
-- ---- BOUNDED, NOT A RE-SEED ---------------------------------------------
--
-- The original seed unnested 1.78M ASINs and needed more than ten minutes.
-- Re-running that hourly is not viable, so this processes a bounded number of
-- sellers per call: those with no queue rows at all (new watches) first, then
-- the least recently synced. queue_synced_at records progress so a run that
-- dies mid-way costs one slice rather than starting over.
--
-- Priority within a seller is unchanged from the seed: our own detections
-- newest-first, then ASINs another watched seller carries, then an md5 fill.
-- Keeping the rule here rather than re-deriving it means a seller topped up
-- today is selected the same way as one seeded yesterday.

ALTER TABLE public.seller_catalog_backfill_state
  ADD COLUMN IF NOT EXISTS queue_synced_at timestamptz;

-- Everything seeded on 2026-09-03 is already current; only new sellers and
-- genuinely stale ones should be picked up on the first run.
UPDATE public.seller_catalog_backfill_state s
   SET queue_synced_at = now()
 WHERE queue_synced_at IS NULL
   AND EXISTS (SELECT 1 FROM public.seller_catalog_queue q
                WHERE q.seller_id = s.seller_id AND q.marketplace = s.marketplace);

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
      -- Never queued, or not refreshed for a week. A seller's catalogue does
      -- change, so this is a refresh cycle rather than a one-shot enrolment.
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

    -- Anything newly queued must also be pending in the cache, or the backfill
    -- worker will never claim it: it selects from asin_brand_cache, not from
    -- the queue.
    INSERT INTO public.asin_brand_cache (asin, checked_at, source)
    SELECT DISTINCT q.asin, NULL, 'spapi'
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

-- Every 20 minutes, staggered off the minute-by-minute brand backfill so the
-- two are not competing for the same rows.
SELECT cron.unschedule('seller-catalog-queue-topup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seller-catalog-queue-topup');

SELECT cron.schedule(
  'seller-catalog-queue-topup',
  '9,29,49 * * * *',
  $cron$ SELECT public.topup_seller_catalog_queue(25, 1000); $cron$
);

DO $$
DECLARE r RECORD; v_pending bigint; v_unqueued bigint;
BEGIN
  SELECT count(*) INTO v_unqueued
  FROM public.seller_watchlist w
  WHERE jsonb_typeof(w.known_asin_list) = 'array'
    AND jsonb_array_length(w.known_asin_list) > 0
    AND NOT EXISTS (SELECT 1 FROM public.seller_catalog_queue q
                     WHERE q.seller_id = w.seller_id AND q.marketplace = w.marketplace);
  RAISE NOTICE 'watched sellers with NO queue rows before top-up: %', v_unqueued;

  SELECT * INTO r FROM public.topup_seller_catalog_queue(25, 1000);
  RAISE NOTICE 'top-up: % sellers, % queue rows, % cache rows',
    r.sellers_processed, r.queue_rows_added, r.cache_rows_added;

  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_pending
    FROM public.asin_brand_cache;
  RAISE NOTICE 'pending brand lookups now: %', v_pending;
END $$;
