DO $p$
DECLARE v_uid uuid; v_req bigint; v_ok boolean;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email='sezflower01@gmail.com';
  v_ok := public.repull_report(39338);
  IF v_ok THEN
    RAISE NOTICE '';
    RAISE NOTICE '== DRY RUN: July, alone ==';
    BEGIN v_req := public.repull_fire(v_uid,'2026-07-01',false);
    EXCEPTION WHEN others THEN RAISE NOTICE '   NOT FIRED: %', SQLERRM; END;
  ELSE
    RAISE NOTICE '   June still running -- holding July';
  END IF;
END
$p$;
