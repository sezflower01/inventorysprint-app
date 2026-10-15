-- READ-ONLY. Two questions:
--   1. did the manual Keepa override survive the automatic sync?
--   2. is the toast right that "fees and ROI follow on the next sync"?
DO $p$
DECLARE v_uid uuid; r record; v_runs int; v_fx numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_fx FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  SELECT count(*) INTO v_runs FROM cron.job_run_details
  WHERE jobid = 190 AND start_time > '2026-10-15 01:36:30+00';
  RAISE NOTICE '== job 190 (auto-sync-sales) runs since the override: % ==', v_runs;
  RAISE NOTICE '';

  FOR r IN
    SELECT so.order_id, so.asin, so.quantity AS qty, so.estimated_price,
           so.locked_est_price, COALESCE(so.locked_from,'(NOT LOCKED)') AS lf,
           COALESCE(so.price_source,'-') AS src, so.sold_price,
           so.referral_fee, so.fba_fee, so.total_fees,
           COALESCE(so.fees_source,'-') AS fsrc, so.updated_at
    FROM public.sales_orders so
    WHERE so.user_id = v_uid
      AND so.order_id IN ('701-1848920-5681843','702-3337276-9597036')
    ORDER BY so.order_id
  LOOP
    RAISE NOTICE '   % % q%', r.order_id, r.asin, r.qty;
    RAISE NOTICE '     est CA$% | locked % | from %',
      r.estimated_price, COALESCE(r.locked_est_price::text,'NULL'), r.lf;
    RAISE NOTICE '     LOCK: %',
      CASE WHEN r.src LIKE 'keepa_buybox:manual%' AND r.estimated_price = r.locked_est_price
           THEN 'HELD - the sync did not overwrite it'
           ELSE 'OVERWRITTEN - lock did not hold (src=' || r.src || ')' END;
    RAISE NOTICE '     stored fees: referral % | fba % | total % | source %',
      COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
      COALESCE(r.total_fees::text,'NULL'), r.fsrc;
    RAISE NOTICE '     row updated %', r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the fee RATE the display can compute from, per ASIN/CA ==';
  FOR r IN
    SELECT fc.asin, fc.referral_rate, fc.fba_fee_fixed,
           COALESCE(fc.fee_source,'-') AS src, fc.updated_at
    FROM public.asin_fee_cache fc
    WHERE fc.user_id = v_uid AND fc.marketplace = 'CA'
      AND fc.asin IN ('B00DLD1C0A','B01E6JQMTI')
    ORDER BY fc.asin
  LOOP
    RAISE NOTICE '   % | referral_rate % | fba_fee_fixed US$% | % | %',
      r.asin, COALESCE(r.referral_rate::text,'NULL'),
      COALESCE(r.fba_fee_fixed::text,'NULL'), rpad(r.src,14), r.updated_at;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no CA fee-cache row for either ASIN)'; END IF;
END
$p$;
