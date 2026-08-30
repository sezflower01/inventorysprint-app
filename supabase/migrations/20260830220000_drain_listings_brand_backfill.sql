-- Drain the seller-watch brand backfill, then remove itself.
--
-- Same shape as 20260830130000_drain_asin_brand_backfill.sql, which cleared
-- ~4,286 inventory ASINs unattended in about 45 minutes. Repeated rather than
-- generalised because the two runs are one-offs against different tables and a
-- shared "drain anything" job would outlive both.
--
-- The dashboard Test panel cannot invoke this function -- it signs a JWT for
-- the selected role instead of sending SUPABASE_SERVICE_ROLE_KEY, so
-- isInternalCaller fails with 403 and there is no service_role option. Manual
-- curl failed too. The secret is therefore read from Vault inside the database,
-- as every other cron here does, and never leaves it.
--
-- Odd minutes ('1-59/2'), never :00 -- on 2026-08-22 sixteen cron jobs failed
-- to START twice in one day when everything due at :00 demanded a pg_cron
-- background worker simultaneously.

SELECT cron.unschedule('drain-listings-brand-backfill')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-listings-brand-backfill');

SELECT cron.schedule(
  'drain-listings-brand-backfill',
  '1-59/2 * * * *',
  $cron$
  DO $inner$
  DECLARE
    v_remaining bigint;
  BEGIN
    SELECT count(*) INTO v_remaining
    FROM public.seller_watch_new_listings
    WHERE brand_checked_at IS NULL;

    IF v_remaining = 0 THEN
      PERFORM cron.unschedule('drain-listings-brand-backfill');
      RAISE NOTICE 'listing brand backfill complete — job unscheduled';
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-asin-brands',
      headers := (
        SELECT jsonb_build_object(
          'Content-Type',      'application/json',
          'x-internal-secret', decrypted_secret::text
        )
        FROM vault.decrypted_secrets
        WHERE name = 'INTERNAL_SYNC_SECRET'
        LIMIT 1
      ),
      body := jsonb_build_object('dryRun', false, 'limit', 200, 'target', 'listings'),
      timeout_milliseconds := 300000
    );
  END
  $inner$;
  $cron$
);

DO $$
DECLARE
  v_left  bigint;
  v_asins bigint;
BEGIN
  SELECT count(*), count(DISTINCT asin) INTO v_left, v_asins
  FROM public.seller_watch_new_listings WHERE brand_checked_at IS NULL;

  RAISE NOTICE 'drain-listings-brand-backfill scheduled (odd minutes).';
  RAISE NOTICE '% listing(s) / % distinct ASIN(s) to look up — about % run(s), ~% minutes.',
    v_left, v_asins, ceil(v_asins / 200.0), ceil(v_asins / 200.0) * 2;
  RAISE NOTICE 'Progress: select count(*) from seller_watch_new_listings where brand_checked_at is null;';
  RAISE NOTICE 'Removes itself at zero. Stop early: select cron.unschedule(''drain-listings-brand-backfill'');';
END $$;
