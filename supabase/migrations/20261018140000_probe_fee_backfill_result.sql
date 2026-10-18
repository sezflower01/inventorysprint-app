-- READ-ONLY. Did the fee backfill actually write a CA row for B07KY25WY7?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  RAISE NOTICE '== the pg_net response for request 29919 ==';
  FOR r IN
    SELECT status_code, left(COALESCE(content,''), 700) AS body,
           COALESCE(error_msg,'(none)') AS err, created
    FROM net._http_response WHERE id = 29919
  LOOP
    RAISE NOTICE '   HTTP % at %', r.status_code, r.created;
    RAISE NOTICE '   error: %', r.err;
    RAISE NOTICE '   body : %', r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no response yet -- still in flight)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== fee cache for B07KY25WY7 now ==';
  FOR r IN
    SELECT marketplace AS mk, referral_rate, fba_fee_fixed,
           COALESCE(fee_source,'-') AS src, COALESCE(last_error,'(none)') AS lerr, updated_at
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND asin = 'B07KY25WY7' ORDER BY marketplace
  LOOP
    RAISE NOTICE '   % | rate % | fba_fee_fixed % | % | %',
      rpad(r.mk,3), COALESCE(round(r.referral_rate::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee_fixed::numeric,4)::text,'NULL'), rpad(r.src,14), r.updated_at;
    RAISE NOTICE '        last_error %', r.lerr;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== and the order row -- did fees land? ==';
  FOR r IN
    SELECT quantity AS qty, estimated_price AS est, referral_fee, fba_fee, total_fees,
           COALESCE(fees_source,'(none)') AS fsrc, COALESCE(fees_missing::text,'-') AS fmiss,
           COALESCE(needs_fee_enrich::text,'-') AS nfe, updated_at
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   est % CAD q% | referral % | fba % | total %',
      r.est, r.qty, COALESCE(round(r.referral_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.total_fees::numeric,4)::text,'NULL');
    RAISE NOTICE '   fees_source % | fees_missing % | needs_fee_enrich % | updated %',
      r.fsrc, r.fmiss, r.nfe, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== re-count the fee-row gap after the backfill ==';
  FOR r IN
    SELECT so.marketplace AS mk, count(*) FILTER (WHERE fc.asin IS NULL) AS no_fee_row,
           count(DISTINCT so.asin) FILTER (WHERE fc.asin IS NULL) AS distinct_asins
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = so.marketplace
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date >= current_date - 90
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders still missing a fee row (% ASINs)',
      rpad(r.mk,3), r.no_fee_row, r.distinct_asins;
  END LOOP;
END
$p$;
