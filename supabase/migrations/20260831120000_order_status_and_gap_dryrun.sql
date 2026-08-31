-- Two jobs: an ongoing order-status refresh, and a one-shot gap investigation.
--
-- ── 1. sync-order-status-updates, hourly ──────────────────────────────────
--
-- fetch-live-orders queries Amazon with CreatedAfter, so an order is fetched
-- once — while Pending — and never asked about again, because it is not
-- *created* in any later window. 19,724 orders have sat at Pending since
-- 2025-12-28, 448 of them already settled. Nothing failed; nothing looked
-- twice.
--
-- LastUpdatedAfter answers the other question, and hourly with a 26-hour
-- lookback means every status change is seen several times over. That overlap
-- is the point: a missed run costs nothing because the next one covers the
-- same ground, and re-reading a status is free where missing one is permanent.
--
-- Minute 22 — not :00, where sixteen jobs failed to START twice on 2026-08-22
-- by all demanding a pg_cron worker at once.
--
-- ── 2. one-shot order-gap dry run ─────────────────────────────────────────
--
-- check_sync_parity over 240 days found ~47 gap days and roughly 1,300 orders
-- present in Amazon's Financial Events but absent from sales_orders, worst in
-- March and April. backfill-order-gaps now accepts a lookbackDays override,
-- but its nightly cron still uses 60 days and cannot see them.
--
-- The dashboard cannot invoke it — the Test panel signs a JWT for the selected
-- role rather than sending the service-role key, so isInternalCaller returns
-- 403 — and curl with that key failed too. So the same pattern as the brand
-- backfills: read the secret from Vault inside the database, and unschedule
-- once it has run.
--
-- dryRun: it REPORTS what it would repair and writes nothing. Deliberately not
-- a live repair: 1,300 orders is a large correction to revenue and P&L, and it
-- should be read before it is made.

SELECT cron.unschedule('sync-order-status-updates-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-order-status-updates-hourly');

SELECT cron.schedule(
  'sync-order-status-updates-hourly',
  '22 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/sync-order-status-updates',
    headers := (
      SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret', decrypted_secret::text)
      FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
    ),
    body := jsonb_build_object('lookbackHours', 26),
    timeout_milliseconds := 300000
  );
  $cron$
);

-- Fires once at the next odd minute, records the result, removes itself.
SELECT cron.unschedule('order-gap-dryrun-once')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'order-gap-dryrun-once');

SELECT cron.schedule(
  'order-gap-dryrun-once',
  '3-59/2 * * * *',
  $cron$
  DO $inner$
  BEGIN
    -- Removes itself BEFORE firing, so a slow or failing call cannot leave it
    -- repeating a 240-day parity scan every two minutes forever.
    PERFORM cron.unschedule('order-gap-dryrun-once');

    PERFORM net.http_post(
      url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-order-gaps',
      headers := (
        SELECT jsonb_build_object('Content-Type','application/json','x-internal-secret', decrypted_secret::text)
        FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1
      ),
      body := jsonb_build_object('dryRun', true, 'lookbackDays', 240),
      timeout_milliseconds := 300000
    );
  END
  $inner$;
  $cron$
);

DO $$
DECLARE v_stuck BIGINT;
BEGIN
  SELECT count(*) INTO v_stuck FROM public.sales_orders WHERE order_status = 'Pending';
  RAISE NOTICE 'sync-order-status-updates-hourly scheduled (minute 22).';
  RAISE NOTICE '% order(s) currently Pending — expect this to fall over the coming hours.', v_stuck;
  RAISE NOTICE 'order-gap-dryrun-once fires within 2 minutes and removes itself.';
  RAISE NOTICE 'Read its result: select status_code, left(content::text, 2000), created from net._http_response order by created desc limit 5;';
END $$;
