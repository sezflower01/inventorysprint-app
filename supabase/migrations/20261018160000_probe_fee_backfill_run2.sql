-- READ-ONLY. Did run 2 (max_asins 60 out of 741 candidate pairs) reach
-- B07KY25WY7/CA?
DO $p$
DECLARE v_uid uuid; r record;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';

  FOR r IN
    SELECT status_code, left(COALESCE(content,''), 500) AS body,
           COALESCE(error_msg,'(none)') AS err, created
    FROM net._http_response WHERE id = 29932
  LOOP
    RAISE NOTICE '== run 2: HTTP % at % ==', r.status_code, r.created;
    RAISE NOTICE '   error %', r.err;
    RAISE NOTICE '   body  %', r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '== run 2 still in flight =='; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== B07KY25WY7 fee rows ==';
  FOR r IN
    SELECT marketplace AS mk, referral_rate, fba_fee_fixed,
           COALESCE(fee_source,'-') AS src, updated_at
    FROM public.asin_fee_cache
    WHERE user_id = v_uid AND asin = 'B07KY25WY7' ORDER BY marketplace
  LOOP
    RAISE NOTICE '   % | rate % | fba % | % | %', rpad(r.mk,3),
      COALESCE(round(r.referral_rate::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee_fixed::numeric,4)::text,'NULL'), rpad(r.src,14), r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== did the ORDER get fees? ==';
  FOR r IN
    SELECT referral_fee, fba_fee, total_fees, COALESCE(fees_source,'(none)') AS fsrc,
           COALESCE(fees_missing::text,'-') AS fmiss, updated_at
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   referral % | fba % | total % | source % | missing % | updated %',
      COALESCE(round(r.referral_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.fba_fee::numeric,4)::text,'NULL'),
      COALESCE(round(r.total_fees::numeric,4)::text,'NULL'),
      r.fsrc, r.fmiss, r.updated_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== how many CA/MX/BR fee rows exist now, vs before (was 436/364/267)? ==';
  FOR r IN
    SELECT marketplace AS mk, count(*) AS rows,
           count(*) FILTER (WHERE fba_fee_fixed > 0) AS usable
    FROM public.asin_fee_cache WHERE user_id = v_uid AND marketplace <> 'US'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '   % | % rows | % usable', rpad(r.mk,3), r.rows, r.usable;
  END LOOP;
END
$p$;
