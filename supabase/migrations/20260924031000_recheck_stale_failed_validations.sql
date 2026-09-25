-- Stop FAILED_VALIDATION being a life sentence.
--
-- Validation runs once, minutes after a listing is created, and Amazon's
-- answer at that moment is often "not ready yet" rather than "never":
-- FBA_INB_0004 on a listing that was inbounded and sold 22 units a fortnight
-- later, and six rows reading "Amazon did not propagate an FNSKU after 7
-- polling attempts". Nothing re-ran the check, so the flag outlived the truth
-- by seven weeks (see 20260924030000, which cleared 5 such listings).
--
-- Daily, this does two things:
--
--   1. CLEARS by evidence. Stock in an Amazon warehouse, or a sale since the
--      listing was created, proves the listing passed inbound. That beats a
--      months-old check, so the flag goes and the reason is preserved in
--      validation_warning.
--
--   2. RE-QUEUES the rest, ONCE. Anything still failed after 24 h goes back
--      through the normal pipeline -- exactly what retry-listing-validation
--      does for a single listing: status PENDING_VALIDATION, a fresh row in
--      listing_validation_queue, and listing-validation-worker (cron #79,
--      every minute) takes it from there. validation_auto_recheck_at records
--      that we did it, so a genuinely blocked listing is retried once and then
--      left alone rather than looping forever. A real block therefore still
--      ends up back at FAILED_VALIDATION, which is the point -- this clears
--      stale flags, it does not hide live ones.

ALTER TABLE public.created_listings
  ADD COLUMN IF NOT EXISTS validation_auto_recheck_at timestamptz;

COMMENT ON COLUMN public.created_listings.validation_auto_recheck_at IS
  'When recheck_stale_failed_validations() last pushed this listing back through validation. Set once; its presence is what stops a permanently blocked listing being re-queued every day.';

CREATE OR REPLACE FUNCTION public.recheck_stale_failed_validations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_cleared int := 0; v_requeued int := 0; r record;
BEGIN
  -- 1. Cleared by evidence.
  FOR r IN
    SELECT cl.id, cl.user_id, cl.asin, cl.sku, cl.validation_failure_reason,
           COALESCE((SELECT sum(COALESCE(i.available,0) + COALESCE(i.reserved,0))
                     FROM public.inventory i WHERE i.user_id = cl.user_id AND i.sku = cl.sku), 0) AS stock,
           (SELECT count(*) FROM public.sales_orders s
            WHERE s.user_id = cl.user_id AND s.asin = cl.asin
              AND COALESCE(s.is_cancelled, false) = false
              AND s.order_date >= cl.date_created) AS sales_since
    FROM public.created_listings cl
    WHERE cl.validation_status = 'FAILED_VALIDATION'
  LOOP
    CONTINUE WHEN r.stock <= 0 AND r.sales_since <= 0;
    UPDATE public.created_listings
    SET validation_status = 'ACTIVE',
        validation_failure_reason = NULL,
        validation_failure_code = NULL,
        validation_warning = format(
          'Validation had failed (%s) but the listing has %s units in stock and %s sale(s) since — cleared automatically on %s.',
          COALESCE(r.validation_failure_reason, 'reason not recorded'), r.stock, r.sales_since,
          to_char(now(), 'YYYY-MM-DD'))
    WHERE id = r.id;
    v_cleared := v_cleared + 1;
  END LOOP;

  -- 2. One re-run through the real pipeline for everything else.
  FOR r IN
    SELECT cl.id, cl.user_id, cl.asin, cl.sku
    FROM public.created_listings cl
    WHERE cl.validation_status = 'FAILED_VALIDATION'
      AND cl.validation_auto_recheck_at IS NULL
      AND cl.date_created < (now() - interval '24 hours')::date
      AND cl.sku IS NOT NULL
    LIMIT 50   -- the worker polls SP-API per listing; a burst helps nobody
  LOOP
    UPDATE public.created_listings
    SET validation_status = 'PENDING_VALIDATION',
        validation_failure_code = NULL,
        validation_failure_reason = NULL,
        validation_completed_at = NULL,
        validation_attempts = 0,
        validation_started_at = now(),
        validation_auto_recheck_at = now()
    WHERE id = r.id;

    INSERT INTO public.listing_validation_queue
      (listing_id, user_id, asin, sku, marketplace, next_stage, attempts, next_run_at, last_error)
    VALUES (r.id, r.user_id, r.asin, r.sku, 'US', 'await_fnsku', 0, now(), NULL)
    ON CONFLICT (listing_id) DO UPDATE
      SET next_stage = 'await_fnsku', attempts = 0, next_run_at = now(), last_error = NULL;

    v_requeued := v_requeued + 1;
  END LOOP;

  RETURN jsonb_build_object('cleared', v_cleared, 'requeued', v_requeued, 'ran_at', now());
END;
$fn$;

REVOKE ALL ON FUNCTION public.recheck_stale_failed_validations() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.recheck_stale_failed_validations() IS
  'Daily: clears FAILED_VALIDATION where stock or sales prove the listing passed inbound, and re-queues anything else once through listing_validation_queue. Cron job recheck-stale-failed-validations.';

-- 06:40 UTC: after the nightly suppression scan (08:30) would clash, and off
-- the busy top of the hour. Staggered like every other job here.
SELECT cron.schedule(
  'recheck-stale-failed-validations',
  '40 6 * * *',
  $cron$ SELECT public.recheck_stale_failed_validations(); $cron$
);

DO $p$
DECLARE v jsonb;
BEGIN
  SELECT public.recheck_stale_failed_validations() INTO v;
  RAISE NOTICE 'first run: %', v;
END
$p$;
