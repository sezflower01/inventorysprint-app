-- Close the window where a new FBA listing is invisible.
--
-- ── THE STRUCTURAL GAP ────────────────────────────────────────────────────
--
-- created_listings and inventory are separate tables with no bridge. The app
-- writes the first; Amazon's report fills the second. But
-- GET_FBA_MYI_ALL_INVENTORY_DATA only lists SKUs that HAVE inventory, so
-- between "listing created" and "Amazon holds stock for it" the listing exists
-- in one table and not the other, and nothing connects them.
--
-- Every new FBA listing passes through that window. Its length is however long
-- sourcing and inbound receipt take -- days, or weeks if stock is bought after
-- the listing is made. Measured 2026-09-01: 12 listings sat in it holding
-- $4,966.75, one of them for a week while actually carrying 13 units available
-- and 39 inbound that no view in the application could show.
--
-- ── WHY PURE SQL, NOT A CRON CALLING AN EDGE FUNCTION ─────────────────────
--
-- The promotion needs no Amazon call at all: the FNSKU is already in our own
-- table, and Amazon assigns one only when it enrols a SKU in FBA, so holding
-- one IS the confirmation. Doing it in SQL avoids every failure mode found on
-- 2026-09-01 while auditing this project's 82 cron jobs:
--
--   * stale anon bearer -> 401 on every run, ~262/hour, unnoticed for months
--   * verify_jwt gateway rejection before the function ever runs
--   * CPU/wall-clock kills that leave no completion record at all
--   * cron.job_run_details reporting success for any completed POST
--
-- None of those can touch a plpgsql function invoked by pg_cron. It either
-- runs or the job row shows it failed.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
--
-- Only rows WITH an fnsku are promoted. The 574 without one were never
-- enrolled in FBA and are correctly invisible -- promoting on `units > 0`
-- (which is the quantity the user typed when planning, not stock Amazon holds)
-- would have inserted 586 phantom SKUs into the repricer and into COGS
-- resolution.
--
-- Quantities are written as zero because they genuinely are zero at this
-- point. The row exists so the listing is visible and enqueued; the ordinary
-- sync fills in real numbers the moment Amazon has them. That cascade is
-- confirmed working -- the Nerf ASIN was promoted with zeros and showed 13/39
-- shortly afterwards.
--
-- source is 'live_api', NOT 'created_listing': the latter is excluded by
-- enqueue_full_inventory_refresh_all_users by design, which would leave the
-- row exactly as invisible as before.

CREATE OR REPLACE FUNCTION public.promote_fba_registered_listings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count int := 0;
BEGIN
  INSERT INTO public.inventory (
    user_id, asin, sku, fnsku, title, image_url, price, cost,
    available, reserved, inbound, source, listing_status,
    last_inventory_sync_at, last_summaries_at
  )
  SELECT
    cl.user_id, cl.asin, cl.sku, cl.fnsku, cl.title, cl.image_url, cl.price, cl.cost,
    0, 0, 0, 'live_api', 'ACTIVE', now(), now()
  FROM public.created_listings cl
  WHERE cl.fnsku IS NOT NULL
    AND cl.asin IS NOT NULL
    AND cl.sku  IS NOT NULL
    -- NOT EXISTS rather than ON CONFLICT: inventory may carry no unique
    -- constraint on (user_id, sku), so the guard has to be explicit. Two
    -- concurrent runs could still race, but the job is single-purpose and
    -- 15 minutes apart.
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory i
      WHERE i.user_id = cl.user_id AND i.sku = cl.sku
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    RAISE NOTICE 'promote_fba_registered_listings: promoted % listing(s)', v_count;
  END IF;

  RETURN v_count;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.promote_fba_registered_listings() TO service_role;

-- Every 15 minutes, offset off :00 -- sixteen jobs failed to START at once on
-- 2026-08-22 by all demanding a pg_cron worker on the hour.
SELECT cron.unschedule('promote-fba-registered-listings-15m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'promote-fba-registered-listings-15m');

SELECT cron.schedule(
  'promote-fba-registered-listings-15m',
  '7,22,37,52 * * * *',
  $cron$ SELECT public.promote_fba_registered_listings(); $cron$
);

DO $$
DECLARE
  v_pending int;
  v_promoted int;
BEGIN
  SELECT count(*) INTO v_pending
    FROM public.created_listings cl
   WHERE cl.fnsku IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.inventory i
                      WHERE i.user_id = cl.user_id AND i.sku = cl.sku);

  SELECT public.promote_fba_registered_listings() INTO v_promoted;

  RAISE NOTICE '% FBA-registered listing(s) were awaiting promotion; % promoted now.', v_pending, v_promoted;
  RAISE NOTICE 'Scheduled every 15 minutes. The invisible window is now at most 15 minutes, not weeks.';
  RAISE NOTICE 'Check: select count(*) from created_listings cl where cl.fnsku is not null and not exists (select 1 from inventory i where i.user_id=cl.user_id and i.sku=cl.sku);';
END $$;
