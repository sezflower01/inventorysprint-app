DO $p$
DECLARE v_uid uuid; v_req bigint; v_s text;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_s := public.repull_report2(55083);
  IF v_s = 'done' THEN
    RAISE NOTICE '';
    RAISE NOTICE '== July dry run, fired alone ==';
    BEGIN v_req := public.repull_fire(v_uid,'2026-07-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSE
    RAISE NOTICE '   June %, holding July (one at a time)', v_s;
  END IF;
END
$p$;
