-- Invoke the re-quote and read ITS response, rather than whatever response
-- happened to be newest (the previous probe read another function's reply).
DO $p$
DECLARE v_uid uuid; v_secret text; v_req bigint; r record; v_cad numeric;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'sezflower01@gmail.com';
  SELECT rate INTO v_cad FROM public.fx_rates WHERE base='USD' AND quote='CAD' LIMIT 1;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/backfill-fee-cache',
    headers := jsonb_build_object('Content-Type','application/json','x-internal-secret', v_secret),
    body := jsonb_build_object(
      'user_id', v_uid::text, 'max_asins', 3, 'force_bypass_ttl', true,
      'only', jsonb_build_array(jsonb_build_object('asin','B07KY25WY7','marketplace','CA'))
    ),
    timeout_milliseconds := 60000
  ) INTO v_req;
  RAISE NOTICE '== invoked, request id % ==', v_req;

  PERFORM pg_sleep(25);

  FOR r IN
    SELECT status_code, left(COALESCE(content,''),400) AS body, COALESCE(error_msg,'(none)') AS err
    FROM net._http_response WHERE id = v_req
  LOOP
    RAISE NOTICE '   HTTP % | err % | %', r.status_code, r.err, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE '   (no response after 25s)'; END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== the order after the re-quote ==';
  FOR r IN
    SELECT quantity AS qty, estimated_price AS est, referral_fee, fba_fee, total_fees,
           COALESCE(fees_source,'(none)') AS fsrc
    FROM public.sales_orders WHERE user_id = v_uid AND order_id = '701-0974352-2997055'
  LOOP
    RAISE NOTICE '   est % CAD q% -> revenue US$%', r.est, r.qty,
      round((r.est*r.qty/v_cad)::numeric,2);
    RAISE NOTICE '   referral % | fba % | total % | source %',
      COALESCE(r.referral_fee::text,'NULL'), COALESCE(r.fba_fee::text,'NULL'),
      COALESCE(r.total_fees::text,'NULL'), r.fsrc;
    IF COALESCE(r.referral_fee,0) > 0 THEN
      RAISE NOTICE '';
      RAISE NOTICE '   referral % CAD -> US$% ( % pct of revenue; want ~15.05 )',
        r.referral_fee, round((r.referral_fee/v_cad)::numeric,2),
        round((100*(r.referral_fee/v_cad)/(r.est*r.qty/v_cad))::numeric,2);
      RAISE NOTICE '   TOTAL FEES US$%',
        round((r.referral_fee/v_cad + COALESCE(r.fba_fee,0))::numeric,2);
    END IF;
  END LOOP;
END
$p$;
