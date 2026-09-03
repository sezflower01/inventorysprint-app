-- Retune the backfill cadence to what the stack actually does.
--
-- The job asked for 1,500 ASINs a run and got exactly 1,000, three runs
-- running: 291,498 -> 290,498 -> 288,498. That ceiling is not in our SQL --
-- claim_catalog_backfill_asins has 4,000 candidates to draw from and a
-- LIMIT of p_max -- it is PostgREST capping rows returned from an RPC.
--
-- Asking for 1,500 and silently receiving 1,000 is the kind of quiet gap that
-- makes later arithmetic wrong, so the request now states 1,000 and the
-- cadence doubles to compensate: ~288 runs at one a minute is ~4.8h instead of
-- 9.6h at the old two-minute spacing.
--
-- Duty cycle stays sane. 1,000 ASINs is 50 batched calls, ~25s at the
-- catalog_api bucket's 2 req/s, so roughly 42% of one minute -- still leaving
-- catalog_api headroom for enrich-missing-titles, classify-listing-brands and
-- check-seller-watchlist's image lookups, which share that bucket.

SELECT cron.unschedule('catalog-brand-backfill');

SELECT cron.schedule(
  'catalog-brand-backfill',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-catalog-brands',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object(
      -- 1,000, because that is what PostgREST will return regardless.
      'maxAsins', 1000, 'sellers', 40, 'perSeller', 100, 'maxSeconds', 50,
      'triggered_by', 'cron-catalog-brand-backfill'
    ),
    timeout_milliseconds := 60000
  );
  $cron$
);

DO $$
DECLARE v_pending bigint;
BEGIN
  SELECT count(*) FILTER (WHERE checked_at IS NULL) INTO v_pending FROM public.asin_brand_cache;
  RAISE NOTICE 'pending=% -> about % hours at 1,000/min',
    v_pending, round((v_pending / 1000.0 / 60.0)::numeric, 1);
END $$;
