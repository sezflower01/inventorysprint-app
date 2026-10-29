-- MAY: verify the apply from the database.
DO $p$
DECLARE r record; v_uid uuid; v_claw numeric; v_rows int; v_changed int; v_n int;
  v_fp_ok boolean := true;
  v_before text[] := ARRAY[
    'liquidation|29|90cadf5d230cda4af0e3f43a5f9987f8',
    'refund|150|87bc31c21a4a4b18654421ef58d2dc2c',
    'service_fee|374|a2f8b4f38a0131af419b4b932ae903ff',
    'shipment|3164|a3fc61200cf650d608a8cf85fa279cb0'];
  v_key text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';

  SELECT count(*) INTO v_rows FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_date >= '2026-05-01' AND event_date < '2026-06-01';
  SELECT COALESCE(sum(compensated_clawback),0) INTO v_claw
  FROM public.financial_events_cache
  WHERE user_id=v_uid AND event_type='adjustment'
    AND event_date >= '2026-05-01' AND event_date < '2026-06-01';

  RAISE NOTICE '== MAY after the apply ==';
  RAISE NOTICE '   rows % (was 3792) | clawbacks stored % (API said -187.96)',
    v_rows, round(v_claw,2);

  IF round(v_claw,2) = 0 THEN
    RAISE NOTICE '   >>> APPLY HAS NOT LANDED YET -- re-read shortly, nothing is wrong';
    RETURN;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '== 1. the four non-adjustment fingerprints ==';
  FOREACH v_key IN ARRAY v_before LOOP
    SELECT count(*) INTO v_n FROM public.fec_other_types_fingerprint(v_uid,'2026-05-01')
    WHERE event_type = split_part(v_key,'|',1)
      AND rows = split_part(v_key,'|',2)::bigint
      AND fingerprint = split_part(v_key,'|',3);
    IF v_n = 1 THEN
      RAISE NOTICE '   % IDENTICAL', rpad(split_part(v_key,'|',1),14);
    ELSE
      v_fp_ok := false;
      RAISE NOTICE '   % !! CHANGED', rpad(split_part(v_key,'|',1),14);
      FOR r IN SELECT * FROM public.fec_other_types_fingerprint(v_uid,'2026-05-01')
               WHERE event_type = split_part(v_key,'|',1)
      LOOP RAISE NOTICE '      now: % rows | %', r.rows, r.fingerprint; END LOOP;
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 2. clawbacks stored vs API ==';
  RAISE NOTICE '   stored % | API -187.96 | match %', round(v_claw,2), (round(v_claw,2) = -187.96);

  RAISE NOTICE '';
  RAISE NOTICE '== 3. diff by key, all 57 columns ==';
  FOR r IN
    SELECT verdict, count(*) AS n FROM public.fec_diff_month(v_uid,'2026-05-01'::date)
    GROUP BY 1 ORDER BY n DESC
  LOOP RAISE NOTICE '   % | % rows', rpad(r.verdict,10), r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '   a sample of what changed:';
  FOR r IN
    SELECT verdict, event_type, event_date, COALESCE(asin,'') AS asin,
           left(COALESCE(after_money::text,'(null)'),130) AS after_m
    FROM public.fec_diff_month(v_uid,'2026-05-01'::date)
    WHERE verdict <> 'unchanged' ORDER BY verdict, event_date LIMIT 6
  LOOP RAISE NOTICE '      % | % | % | %', rpad(r.verdict,8), r.event_type, r.event_date, r.after_m; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '== 4. other months unchanged ==';
  FOR r IN
    SELECT to_char(event_date,'YYYY-MM') AS m,
           round(COALESCE(sum(compensated_clawback),0)::numeric,2) AS claw, count(*) AS rows
    FROM public.financial_events_cache
    WHERE user_id=v_uid AND event_type='adjustment'
      AND event_date >= '2026-01-01' AND event_date < '2027-01-01'
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '   % | % adjustment rows | clawbacks %', r.m, lpad(r.rows::text,4), lpad(r.claw::text,10); END LOOP;

  IF NOT v_fp_ok THEN
    RAISE EXCEPTION 'a non-adjustment fingerprint CHANGED -- run fec_restore_month';
  END IF;
  RAISE NOTICE '';
  RAISE NOTICE '   ALL CHECKS PASSED';
END
$p$;
