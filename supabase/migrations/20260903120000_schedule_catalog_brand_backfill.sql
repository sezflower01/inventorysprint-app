-- Schedule the catalogue brand backfill and the rollup that renders it.
--
-- Proven by hand first: request 71354 returned
-- {"claimed":54,"looked":54,"withBrand":54,"hitRate":100,...}. pg_cron records
-- SUCCESS for any completed POST regardless of the response, so a job that has
-- never been verified by hand looks identical to one that works.
--
-- ---- CADENCE ------------------------------------------------------------
--
-- 291,498 pending at 1,500 ASINs per run is ~195 runs. Every 2 minutes puts
-- the finish ~6.5 hours out, one overnight window.
--
-- Every 2 minutes rather than every minute on purpose. A run needs ~38s of API
-- time (75 batched calls at the bucket's 2 req/s), so this holds roughly a 30%
-- duty cycle on catalog_api and leaves the rest for enrich-missing-titles,
-- classify-listing-brands and check-seller-watchlist's image lookups, which
-- share that bucket. Draining it flat out would starve all three to finish
-- three hours sooner, which is not a trade worth making for a backfill that
-- has nowhere to be.
--
-- Staggered off the existing jobs (check-price-alerts :00,
-- check-seller-watchlist :15) so quota-spending work does not burst together.

SET statement_timeout TO '900s';

SELECT cron.schedule(
  'catalog-brand-backfill',
  '1-59/2 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-catalog-brands',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        -- The vault secret, never an anon bearer: a key rotation silently
        -- broke four crons in this database and they reported success for ten
        -- days while doing nothing.
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object(
      'maxAsins', 1500, 'sellers', 40, 'perSeller', 100, 'maxSeconds', 55,
      'triggered_by', 'cron-catalog-brand-backfill'
    ),
    timeout_milliseconds := 120000
  );
  $cron$
);

-- The rollup is what the Seller catalogue tab actually reads, so it has to
-- follow the backfill rather than run on its own unrelated schedule. Hourly at
-- :07 -- often enough that the tab visibly fills during the backfill, rare
-- enough that a full recompute is not competing with itself.
SELECT cron.schedule(
  'seller-brand-catalog-rollup',
  '7 * * * *',
  $cron$ SELECT public.refresh_seller_brand_catalog_rollup(); $cron$
);

-- Populate it now so the tab is not empty until the first hourly tick.
DO $$
DECLARE t0 timestamptz := clock_timestamp(); v_rows bigint;
BEGIN
  SELECT public.refresh_seller_brand_catalog_rollup() INTO v_rows;
  RAISE NOTICE 'rollup rebuilt: % rows in %', v_rows, clock_timestamp() - t0;
END $$;

DO $$
DECLARE v_pending bigint; v_matched bigint; v_sellers bigint;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_pending FROM public.asin_brand_cache;
  SELECT count(*), COALESCE(sum(matched_items),0) INTO v_sellers, v_matched
    FROM public.seller_brand_catalog_rollup WHERE matched_items > 0;
  RAISE NOTICE 'pending lookups=% | sellers with a match=% | matched items=%',
    v_pending, v_sellers, v_matched;
  RAISE NOTICE 'backfill runs every 2 min; expect completion in roughly % hours',
    round((v_pending / 1500.0 * 2.0 / 60.0)::numeric, 1);
END $$;
