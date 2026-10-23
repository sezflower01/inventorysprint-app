DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_ok := public.repull_report(39326);
  IF v_ok THEN
    RAISE NOTICE '';
    RAISE NOTICE '== DRY RUN: June, alone ==';
    BEGIN v_req := public.repull_fire(v_uid,'2026-06-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSE
    RAISE NOTICE '   March still running -- not firing June (one at a time)';
  END IF;
END
$p$;
