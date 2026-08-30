-- Drain the brand backfill on a cron, then remove itself.
--
-- ── WHY A CRON RATHER THAN CLICKING INVOKE ────────────────────────────────
--
-- backfill-asin-brands is bounded to 200 ASINs per call, so clearing ~4,285
-- distinct ASINs (12,053 inventory rows) takes ~22 invocations. Two problems
-- with doing that by hand:
--
--   1. The dashboard's Test panel signs a JWT for the selected role
--      (postgres/anon/authenticated) rather than sending the raw
--      SUPABASE_SERVICE_ROLE_KEY, so it never satisfies isInternalCaller and
--      returns 403 Forbidden. There is no service_role option in that dropdown.
--   2. The alternative -- curl with the service-role key -- puts a
--      full-privilege credential into shell history for a one-off task.
--
-- This uses the pattern the other crons already use: the secret is read from
-- Vault inside the database and never leaves it.
--
-- ── IT UNSCHEDULES ITSELF ─────────────────────────────────────────────────
--
-- A temporary job that has to be removed by hand is a job that gets forgotten
-- and runs forever. This one checks the backlog first and drops itself the
-- moment there is nothing left, so no follow-up step is owed.
--
-- ── CADENCE ───────────────────────────────────────────────────────────────
--
-- Every 2 minutes on ODD minutes ('1-59/2'), so it never lands on :00. That is
-- not cosmetic: on 2026-08-22, 16 cron jobs failed to START twice in one day
-- because every job due at :00 demanded a pg_cron background worker at the same
-- instant and exhausted the pool. ~22 runs at 2-minute spacing finishes in
-- about 45 minutes.
--
-- Does NOT compete with the repricer. Amazon rate-limits per operation:
-- getCatalogItem has its own quota, separate from the getItemOffers /
-- getCompetitivePricing bucket the repricer uses.

SELECT cron.unschedule('drain-asin-brand-backfill')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-asin-brand-backfill');

SELECT cron.schedule(
  'drain-asin-brand-backfill',
  '1-59/2 * * * *',
  $cron$
  DO $inner$
  DECLARE
    v_remaining bigint;
  BEGIN
    SELECT count(*) INTO v_remaining
    FROM public.inventory
    WHERE brand_checked_at IS NULL;

    IF v_remaining = 0 THEN
      -- Done. Remove the job rather than idle forever.
      PERFORM cron.unschedule('drain-asin-brand-backfill');
      RAISE NOTICE 'asin brand backfill complete — job unscheduled';
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
      body := jsonb_build_object('dryRun', false, 'limit', 200),
      timeout_milliseconds := 300000
    );
  END
  $inner$;
  $cron$
);

DO $$
DECLARE
  v_remaining bigint;
  v_asins     bigint;
BEGIN
  SELECT count(*), count(DISTINCT asin) INTO v_remaining, v_asins
  FROM public.inventory WHERE brand_checked_at IS NULL;

  RAISE NOTICE 'drain-asin-brand-backfill scheduled every 2 min (odd minutes).';
  RAISE NOTICE '% row(s) / % distinct ASIN(s) awaiting lookup — about % run(s), ~% minutes.',
    v_remaining, v_asins, ceil(v_asins / 200.0), ceil(v_asins / 200.0) * 2;
  RAISE NOTICE 'Progress: select count(*) from inventory where brand_checked_at is null;';
  RAISE NOTICE 'The job removes itself once that reaches 0. To stop early: select cron.unschedule(''drain-asin-brand-backfill'');';
END $$;
