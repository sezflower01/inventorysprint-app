-- READ-ONLY. Did the fixed writer produce the right fee?
DO $p$
DECLARE v_uid uuid; r record; v_cad numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;

  FOR r IN
    SELECT id, status_code, left(COALESCE(content,''),300) AS body
    FROM net._http_response WHERE id = (SELECT max(id) FROM net._http_response)
  LOOP
    RAISE NOTICE '== latest backfill response: HTTP % | % ==', r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== the order now ==';
  FOR r IN
    SELECT quantity AS qty, estimated_price AS est, referral_fee, fba_fee, total_fees,
           COALESCE(fees_source,'(none)') AS fsrc, COALESCE(fees_missing::text,'-') AS fmiss
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   estimated_price % CAD (q%) -> revenue US$%',
      r.est, r.qty, round((r.est*r.qty/v_cad)::numeric,2);
    RAISE NOTICE '   stored referral_fee % | fba_fee % | total_fees % | source %',
      COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
      COALESCE(r.total_fees::text,'NULL'), r.fsrc;
    IF r.referral_fee IS NOT NULL THEN
      RAISE NOTICE '';
      RAISE NOTICE '   DISPLAY MATH (from_cache = referral NATIVE, fba USD):';
      RAISE NOTICE '     referral % CAD / % = US$%',
        r.referral_fee, v_cad, round((r.referral_fee/v_cad)::numeric,2);
      RAISE NOTICE '     fba                = US$%', r.fba_fee;
      RAISE NOTICE '     total              = US$%',
        round((r.referral_fee/v_cad + COALESCE(r.fba_fee,0))::numeric,2);
      RAISE NOTICE '     referral as pct of revenue = % pct (want ~15.05)',
        round((100*(r.referral_fee/v_cad)/(r.est*r.qty/v_cad))::numeric,2);
    END IF;
  END LOOP;
END
$p$;
