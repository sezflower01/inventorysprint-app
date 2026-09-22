-- READ-ONLY PROBE. Did pricing-suppression-worker process the queued re-check
-- of B09N1RG7JC (US), and what did Amazon say?

DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN SELECT status, attempts, last_error, priority, to_char(created_at, 'HH24:MI:SS') AS queued,
                  to_char(processed_at, 'HH24:MI:SS') AS processed
           FROM public.pricing_suppression_check_queue
           WHERE user_id = v_uid AND sku = '1067509411' AND marketplace = 'US'
           ORDER BY created_at DESC LIMIT 3 LOOP
    RAISE NOTICE 'queue: % (attempts %, priority %) queued % processed % | error %',
      r.status, r.attempts, r.priority, r.queued, COALESCE(r.processed, '-'), COALESCE(r.last_error, '-');
  END LOOP;

  FOR r IN SELECT status, is_enabled, is_listing_inactive_not_buyable AS inactive, listing_inactive_statuses,
                  to_char(listing_inactive_last_checked_at, 'HH24:MI:SS') AS checked,
                  to_char(listing_inactive_cleared_at, 'HH24:MI:SS') AS cleared,
                  listing_inactive_reason_code, left(listing_inactive_reason_message, 160) AS reason
           FROM public.repricer_assignments
           WHERE user_id = v_uid AND asin = 'B09N1RG7JC' AND marketplace = 'US' LOOP
    RAISE NOTICE 'US assignment: % enabled=% | inactive % | Amazon statuses % | checked % | cleared %',
      r.status, r.is_enabled, r.inactive, r.listing_inactive_statuses, r.checked, COALESCE(r.cleared, '-');
    RAISE NOTICE '  Amazon reason: % %', COALESCE(r.listing_inactive_reason_code, '-'), COALESCE(r.reason, '-');
  END LOOP;
END
$p$;
