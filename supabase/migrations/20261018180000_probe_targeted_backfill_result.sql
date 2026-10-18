-- READ-ONLY. Did the TARGETED backfill write the CA fee row, and did the
-- order pick the fees up?
DO $p$
DECLARE v_uid uuid; r record; v_cad numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  RAISE NOTICE '== responses from all three backfill runs ==';
  FOR r IN
    SELECT id, status_code, left(COALESCE(content,''), 300) AS body, created
    FROM net._http_response WHERE id IN (29919, 29932, 29961) ORDER BY id
  LOOP
    RAISE NOTICE '   req % | HTTP % | %', r.id, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== B07KY25WY7 fee rows ==';
  FOR r IN
    SELECT marketplace AS mk, referral_rate, fba_fee_fixed,
           COALESCE(fee_source,'-') AS src, COALESCE(last_error,'(none)') AS lerr, updated_at
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND asin = 'B07KY25WY7' ORDER BY marketplace
  LOOP
    RAISE NOTICE '   % | referral % | fba_fee_fixed US$% | % | %',
      rpad(r.mk,3), COALESCE(round(r.referral_rate::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee_fixed::numeric,4)::text,'NULL'), rpad(r.src,14), r.updated_at;
    IF r.lerr <> '(none)' THEN RAISE NOTICE '        last_error %', r.lerr; END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the order: price and fees ==';
  FOR r IN
    SELECT quantity AS qty, estimated_price AS est,
           referral_fee, fba_fee, total_fees,
           COALESCE(fees_source,'(none)') AS fsrc,
           COALESCE(fees_missing::text,'-') AS fmiss, updated_at
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   est % CAD x % = US$% revenue',
      r.est, r.qty, round((r.est*r.qty/v_cad)::numeric,2);
    RAISE NOTICE '   fees: referral % | fba % | total % | source % | missing %',
      COALESCE(round(r.referral_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.total_fees::numeric,4)::text,'NULL'), r.fsrc, r.fmiss;
    RAISE NOTICE '   updated %', r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== fee-row gap, final ==';
  FOR r IN
    SELECT so.marketplace AS mk, count(*) FILTER (WHERE fc.asin IS NULL) AS no_row,
           count(DISTINCT so.asin) FILTER (WHERE fc.asin IS NULL) AS asins
    FROM public.sales_orders so
    LEFT JOIN public.asin_fee_cache fc
      ON fc.user_id = so.user_id AND fc.asin = so.asin AND fc.marketplace = so.marketplace
    WHERE so.user_id = v_uid AND upper(COALESCE(so.marketplace,'US')) <> 'US'
      AND COALESCE(so.is_cancelled,false) = false AND so.order_id NOT LIKE '%-REFUND%'
      AND so.order_date >= current_date - 90
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % orders missing a fee row (% ASINs)', rpad(r.mk,3), r.no_row, r.asins;
  END LOOP;
END
$p$;
