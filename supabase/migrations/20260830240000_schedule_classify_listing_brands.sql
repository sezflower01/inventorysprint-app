-- Run the brand classifier every 5 minutes.
--
-- Detection (check-seller-watchlist) runs on '2-57/5'. This is offset to
-- '4-59/5' so classification lands a couple of minutes after a sweep rather
-- than racing it, and neither is on :00 -- on 2026-08-22 sixteen cron jobs
-- failed to START twice in one day when everything due at :00 asked pg_cron
-- for a background worker at the same instant.
--
-- Five minutes is deliberate rather than reluctant. Classifying inline inside
-- check-seller-watchlist would put SP-API catalog calls inside a Keepa-gated,
-- rate-sensitive sweep and couple two unrelated quotas. A few minutes is
-- indistinguishable from instant for a sourcing decision acted on within
-- hours.
--
-- The same invocation also sends the digest; it only emails matches that have
-- been sitting for 45 minutes, so a seller bulk-listing 50 items produces one
-- email rather than ten.

SELECT cron.unschedule('classify-listing-brands-5min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'classify-listing-brands-5min');

SELECT cron.schedule(
  'classify-listing-brands-5min',
  '4-59/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/classify-listing-brands',
    headers := (
      SELECT jsonb_build_object(
        'Content-Type',      'application/json',
        'x-internal-secret', decrypted_secret::text
      )
      FROM vault.decrypted_secrets
      WHERE name = 'INTERNAL_SYNC_SECRET'
      LIMIT 1
    ),
    body := jsonb_build_object('triggered_by', 'cron-5min', 'time', now()::text),
    timeout_milliseconds := 300000
  );
  $cron$
);

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.seller_watch_new_listings WHERE brand_match_state = 'pending';
  RAISE NOTICE 'classify-listing-brands-5min scheduled (minutes 4,9,...,59).';
  RAISE NOTICE '% listing(s) pending classification; 100 per run.', n;
  RAISE NOTICE 'Digest emails matches idle for 45 min. Verify the address first: Seller Analyzer settings -> Send test.';
END $$;
