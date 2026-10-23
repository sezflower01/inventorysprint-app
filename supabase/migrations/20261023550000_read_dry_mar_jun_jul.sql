DO $p$
DECLARE v_uid uuid; v_ok boolean; v_id bigint; v_req bigint; v_pending int := 0;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  RAISE NOTICE '== outstanding dry runs ==';
  FOREACH v_id IN ARRAY ARRAY[38121::bigint, 38122, 38134] LOOP
    v_ok := public.repull_report(v_id);
    IF NOT v_ok THEN v_pending := v_pending + 1; END IF;
  END LOOP;
  RAISE NOTICE '';
  RAISE NOTICE '   % of 3 still pending', v_pending;
  -- Re-fire March only if its earlier attempt is confirmed gone (it was the
  -- 429 casualty and may never return a row).
  IF NOT EXISTS (SELECT 1 FROM net._http_response WHERE id = 38121) THEN
    RAISE NOTICE '';
    RAISE NOTICE '== March has no response; re-firing it alone ==';
    BEGIN v_req := public.repull_fire(v_uid,'2026-03-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  END IF;
END
$p$;
