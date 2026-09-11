-- PAUSE repair-collapsed-orders-15min. It is spending shared quota on nothing.
--
-- Measured over the 23 runs still retained in net._http_response
-- (2026-09-11 07:08 .. 12:39 UTC):
--
--   SP-API calls  1,149
--   repaired          0
--   already correct 1,046
--   throttled       103
--
-- Cause: the scheduled body posts 'offset', 0 on every run. A REPAIRED row leaves
-- the shortlist because its quantity is no longer 1; an ALREADY-CORRECT row
-- never does. So once the repairable rows near the head were fixed, every run
-- re-checked the same 50 cleared rows -- the fx count of 40 is identical run
-- after run, which is the same 40 non-USD orders being fetched again.
--
-- The offset paging added in 20260909110000 was real and never wired into the
-- cron. pg_cron reported "succeeded" 146 times because it only records that
-- the HTTP call was dispatched, not what the function then did.
--
-- This is not free waste. The Orders API quota is account-wide and shared with
-- sync-sales-orders, and the 103 throttles are this job colliding with other
-- callers -- about 200 wasted calls an hour against the sales sync's budget.
--
-- Paused rather than fixed in place: the fix needs a checked-marker the function
-- writes, and rescheduling before that function is deployed would resume the
-- same loop. Rescheduled in a later migration once it is live.

DO $pause$
DECLARE v_was boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repair-collapsed-orders-15min')
    INTO v_was;

  IF v_was THEN
    PERFORM cron.unschedule('repair-collapsed-orders-15min');
    RAISE NOTICE 'unscheduled repair-collapsed-orders-15min';
  ELSE
    RAISE NOTICE 'repair-collapsed-orders-15min was not scheduled -- nothing to pause';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'repair-collapsed-orders-15min') THEN
    RAISE EXCEPTION 'repair-collapsed-orders-15min is still scheduled after unschedule';
  END IF;
  RAISE NOTICE 'verified: job no longer present in cron.job';
END
$pause$;
